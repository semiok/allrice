import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MonthlyScheduleRule } from '@allrice/contracts';
import { createP27CodexWorkerFixture } from '../../../scripts/acceptance/runtime/p27-codex-worker-fixture.ts';
import { createChatSession, sendChatMessage } from './workspace/service.ts';
import {
  employeeManifest,
  employeeManifestChecksum,
} from './employees/employee-config.ts';
import { claimNextJob, startClaimedJob, failJob } from './execution/queue.ts';
import {
  createRecurringTask,
  createRecurringTaskFromExecutionContext,
  changeRecurringTask,
  getRecurringTask,
  listRecurringTasks,
  initializeNativeRecurringPartition,
  lockNativeRecurringAdmissions,
  dispatchNextNativeRecurringOccurrence,
} from './native-schedule-recurring-product.ts';
import { lockNativeOnceJobAdmission } from './native-schedule-once-authority.ts';
import { createNativeRecurringSqlStore } from './native-schedule-recurring-sql.ts';
import {
  lockNativeCalendarAdmissions,
  materializeNativeCalendar,
} from './native-schedule-calendar-consumers.ts';
import { ordinaryMonthlyControl } from './native-schedule-monthly.ts';
import {
  calendarControlIdentity,
  type NativeCalendarWrite,
} from './native-schedule-calendar-state.ts';
import {
  calendarPlanFor,
  insertCalendarPlanInTransaction,
} from './native-schedule-calendar-business.ts';
import {
  nextMonthlyBusinessTarget,
  latestMonthlyBusinessTarget,
} from './native-schedule-monthly-time.ts';
import {
  nativeOnceDigest,
  type NativeOnceWriter,
  type NativeOnceTask,
} from './native-schedule-once-state.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';
import * as client from './core/client.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'ordinary monthly original chat and immutable business proof; isolated SQL only, no Host/model',
  { timeout: 30000 },
  () => {
    let f: Awaited<ReturnType<typeof createP27CodexWorkerFixture>>;
    let root: string;
    let store: ReturnType<typeof createNativeRecurringSqlStore>,
      writer: NativeOnceWriter;
    const reference = {
      artifactId: `sha256:${'b'.repeat(64)}`,
      profileId: 'allrice-recurring-control-v1',
      storageId: 'isolated-monthly-sql',
      stateRoot: '/isolated/monthly-sql',
    };
    const ready = {
      enabled: true,
      storageReady: true,
      legacyClockExcluded: true,
      controlArtifactApproved: true,
    };
    const rule: MonthlyScheduleRule = {
      kind: 'monthly',
      monthDay: 31,
      time: '02:30:17',
      timezone: 'America/New_York',
    };
    const write = (
      mutation: NativeCalendarWrite['mutation'],
    ): NativeCalendarWrite => ({
      writeId: randomUUID(),
      digest: nativeOnceDigest(mutation),
      mutation,
    });
    const calendar = () => store.calendar!;
    beforeEach(async () => {
      vi.stubEnv('ALLRICE_NATIVE_RECURRING_ENABLED', '1');
      vi.stubEnv('ALLRICE_NATIVE_CALENDAR_ENABLED', '1');
      vi.stubEnv('ALLRICE_EXPERIENCE_REVIEW_ENABLED', '0');
      vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '0');
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
      root = await realpath(
        await mkdtemp(join(tmpdir(), 'allrice-monthly-sql-')),
      );
      reference.stateRoot = root;
      vi.stubEnv(
        'ALLRICE_NATIVE_RECURRING_REFERENCE',
        JSON.stringify(reference),
      );
      f = await createP27CodexWorkerFixture({
        allowCiDatabase: true,
        personalProfile: 'writable',
      });
      vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
      const manifest = employeeManifest({
        key: 'p27-codex-worker',
        name: 'Monthly original chat fixture',
        description: 'SQL assertions only',
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
      await initializeNativeRecurringPartition(reference);
      store = createNativeRecurringSqlStore({
        db: f.db,
        partitionId: 'allrice-recurring-v1',
        ownerId: randomUUID(),
        reference,
        ttlMs: 300000,
        readiness: () => ready,
        decodeTask: (v) => structuredClone(v) as NativeOnceTask,
        lockAdmission: lockNativeRecurringAdmissions,
        calendar: {
          enabled: true,
          lockAdmission: lockNativeCalendarAdmissions,
        },
        proveClosed: async () => null,
      });
      writer = (await store.acquireWriter())!.writer;
    }, 120000);
    afterEach(async () => {
      try {
        await f?.close();
      } finally {
        if (root) await rm(root, { recursive: true, force: true });
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
      }
    }, 30000);
    async function session() {
      return createChatSession(f.context, {
        workspaceId: f.workspaceId,
        employeeAssignmentId: f.assignmentId,
        title: 'Ordinary monthly SQL',
      });
    }
    async function publicTask() {
      const s = await session(),
        input = {
          clientRequestId: randomUUID(),
          name: '月末核对',
          prompt: '核对本月报表，逐项列出异常。保留原始要求。',
          rule,
        };
      const task = await createRecurringTask(f.context, s.id, input);
      return { id: task.id, sessionId: s.id, input };
    }
    async function operation(
      t: { id: string; sessionId: string },
      operationId: string,
    ) {
      const read = await getRecurringTask(f.context, t.sessionId, t.id, {
        operationId,
      });
      if (!('operation' in read) || !read.operation)
        throw Error('missing exact monthly operation');
      return read.operation;
    }
    async function stateCounts(id: string) {
      const [row] = await f.db`select
      (select count(*)::int from allrice_native_calendar_plans where automation_id=${id}) plans,
      (select count(*)::int from allrice_native_calendar_plans where automation_id=${id} and closed_decision_id is null) open_plans,
      (select count(*)::int from allrice_native_calendar_arms a join allrice_native_calendar_periods p on p.period_id=a.period_id where p.automation_id=${id}) arms`;
      return row!;
    }
    /** Component-only backend put/receipt. Actual public create/delivery/delete
     * and normal Host drain are a separately executed parent-owned acceptance. */
    async function sqlBinding(id: string) {
      expect(await store.renewWriter(writer)).not.toBeNull();
      let state = await calendar().loadCalendarState(writer);
      const parent = state.controls.find((r) => r.control.automationId === id)!;
      if (parent.control.sessionState === 'reserved')
        for (const [action, expectedControlVersion] of [
          ['session_initializing', parent.version],
          ['session_ready', parent.version + 1],
        ] as const)
          expect(
            await store.commitMutation(
              writer,
              write({
                kind: 'calendar',
                action,
                controlId: parent.control.controlId,
                expectedControlVersion,
              }),
            ),
          ).toBe('committed');
      for (let i = 0; i < 8; i++) {
        state = await calendar().loadCalendarState(writer);
        if (
          state.bindings.some((r) => r.period.automationId === id && !r.closed)
        )
          break;
        await materializeNativeCalendar(calendar(), writer, reference);
      }
      state = await calendar().loadCalendarState(writer);
      const c = state.controls.find(
        (r) => r.control.automationId === id,
      )!.control;
      let b = state.bindings.find(
        (r) => r.period.automationId === id && !r.closed,
      )!;
      expect(b).toBeDefined();
      if (Date.parse(b.arm.nativeAt) <= Date.now()) {
        const absent = await calendar().confirmCalendarArmAbsent(writer, {
          periodId: b.period.periodId,
          armId: b.arm.armId,
          requestDigest: b.arm.requestDigest,
          expectedPeriodVersion: b.period.version,
          expectedArmVersion: b.arm.snapshotVersion,
          taskRecords: await store.loadTaskRecords(writer),
        });
        b = {
          ...b,
          ...(await calendar().prepareCalendarArm(writer, {
            periodId: b.period.periodId,
            previousArmId: absent.arm.armId,
            expectedPeriodVersion: absent.period.version,
            expectedArmVersion: absent.arm.snapshotVersion,
            armId: randomUUID(),
            nativeAt: new Date(Date.now() + 60000).toISOString(),
          })),
        };
      }
      b = {
        ...b,
        ...(await calendar().beginCalendarArmCreate(writer, {
          periodId: b.period.periodId,
          armId: b.arm.armId,
          requestDigest: b.arm.requestDigest,
          expectedPeriodVersion: b.period.version,
          expectedArmVersion: b.arm.snapshotVersion,
        })),
      };
      let task: NativeOnceTask = {
        sessionId: c.controlSessionId,
        status: 'active',
        record: {
          id: randomUUID(),
          kind: 'at',
          scheduledAt: b.arm.nativeAt,
          title: 'AllRice once control',
          prompt:
            'Synthetic schedule control only. Never execute business work.',
        },
      };
      async function put() {
        const w = write({
          kind: 'calendar',
          action: 'put_task',
          controlId: c.controlId,
          periodId: b.period.periodId,
          armId: b.arm.armId,
          requestDigest: b.arm.requestDigest,
          expectedPeriodVersion: b.period.version,
          expectedArmVersion: b.arm.snapshotVersion,
          task,
        });
        expect(await store.commitMutation(writer, w)).toBe('committed');
        expect(await store.readExactCommit(writer, w)).toBe('committed');
        const exact = await calendar().readExactCalendarArm(
          b.arm.armId,
          b.arm.requestDigest,
        );
        if (exact.state !== 'bound')
          throw Error('monthly SQL Task not exactly bound');
        b = { ...b, period: exact.period, arm: exact.arm };
        return w;
      }
      await put();
      return {
        periodId: b.period.periodId,
        control: c,
        async receipt() {
          const delivery = {
            scheduledAt: b.arm.nativeAt,
            deliveredAt: new Date(
              Date.parse(b.arm.nativeAt) + 1000,
            ).toISOString(),
            messageId: randomUUID(),
          };
          task = {
            ...task,
            status: 'inactive',
            lastDelivery: delivery,
            deliveryHistory: {
              records: [{ ...delivery, prompt: task.record.prompt }],
              earlierRecordsUnavailable: false,
            },
          };
          return put();
        },
      };
    }
    async function retireSqlTasks(id: string) {
      const state = await calendar().loadCalendarState(writer);
      for (const b of state.bindings.filter(
        (r) => r.period.automationId === id && r.closed && r.arm.nativeTaskId,
      )) {
        expect(b.retirement).not.toBeNull();
        const mutation = {
          kind: 'calendar' as const,
          action: 'retire_task' as const,
          controlId: b.period.controlId,
          periodId: b.period.periodId,
          armId: b.arm.armId,
          retirementId: b.retirement!.retirementId,
          nativeTaskId: b.arm.nativeTaskId!,
          taskDigest: nativeOnceDigest(b.arm.taskSnapshot),
          expectedArmVersion: b.arm.snapshotVersion,
        };
        expect(await store.commitMutation(writer, write(mutation))).toBe(
          'committed',
        );
        expect(
          await calendar().readExactCalendarRetirement(
            b.retirement!.retirementId,
          ),
        ).toBe('committed');
      }
    }
    /** Represents an earlier, valid creation in this disposable schema, without
     * editing an immutable P or adding any production clock override. */
    async function historicalTask(
      mode: 'latest' | 'old',
      prompt = '只输出当前月报核对结果，不创建新定时任务。',
    ) {
      const s = await session(),
        [instance] = await f.db<
          { id: string }[]
        >`select id from allrice_employee_instances where assignment_id=${f.assignmentId} and owner_id=${f.ownerId} and archived_at is null`;
      const id = randomUUID(),
        requestId = randomUUID(),
        content = { name: '原始历史月报', prompt };
      const latest = latestMonthlyBusinessTarget(rule, new Date()),
        acceptedAt =
          mode === 'latest'
            ? new Date(latest.getTime() - 1)
            : new Date(Date.now() - 100 * 86400000);
      const P = nextMonthlyBusinessTarget(rule, acceptedAt);
      const c = ordinaryMonthlyControl({
        kind: 'calendar',
        binding: 'rotating-at-v1',
        partitionId: 'allrice-recurring-v1',
        controlId: randomUUID(),
        automationId: id,
        organizationId: f.organizationId,
        workspaceId: f.workspaceId,
        ownerId: f.ownerId,
        revision: 1,
        controlSessionId: `historical-monthly-${randomUUID()}`,
        reference,
        sessionState: 'reserved',
        nativeTaskId: null,
        dispatch: {
          consumer: 'ordinary-monthly-v1',
          employeeAssignmentId: f.assignmentId,
          employeeInstanceId: instance!.id,
          businessSessionId: s.id,
        },
      });
      const raw = {
        kind: 'calendar' as const,
        binding: 'rotating-at-v1' as const,
        consumer: 'ordinary-monthly-v1' as const,
        revision: 1,
        rule,
        contentDigest: runtimePolicyDigest(content),
        acceptedAt: acceptedAt.toISOString(),
      };
      const v = {
        ...raw,
        reservationDigest: nativeOnceDigest({
          organizationId: f.organizationId,
          workspaceId: f.workspaceId,
          ownerId: f.ownerId,
          automationId: id,
          employeeAssignmentId: f.assignmentId,
          employeeInstanceId: instance!.id,
          businessSessionId: s.id,
          ...raw,
        }),
      };
      await f.db.begin(async (tx) => {
        await tx`insert into allrice_automations(id,organization_id,workspace_id,owner_id,name,prompt,trigger_type,schedule,status,conversation_mode,employee_assignment_id,session_id,
        next_run_at,clock_owner,native_recurring_request_id,native_recurring_request_digest,native_recurring_revision,created_at)
        values(${id},${f.organizationId},${f.workspaceId},${f.ownerId},${content.name},${content.prompt},'schedule',${tx.json({ frequency: 'native_recurring', rule })},'enabled','reuse',${f.assignmentId},${s.id},${P},
          'native_recurring',${requestId},${runtimePolicyDigest({ sessionId: s.id, clientRequestId: requestId, ...content, rule })},1,${acceptedAt})`;
        await tx`insert into allrice_native_recurring_versions(automation_id,revision,configuration,business_content,business_content_digest)
        values(${id},1,${tx.json(v)},${tx.json(content)},${v.contentDigest})`;
        await tx`insert into allrice_native_recurring_controls(partition_id,control_id,automation_id,control_session_id,immutable_identity,snapshot)
        values(${c.partitionId},${c.controlId},${id},${c.controlSessionId},${tx.json(calendarControlIdentity(c))},${tx.json({ control: c, task: null })})`;
        await insertCalendarPlanInTransaction(
          tx,
          calendarPlanFor(c, v, P, acceptedAt, { kind: 'request', requestId }),
        );
      });
      return { id, sessionId: s.id, P, content };
    }

    it('creates from current human monthly source, preserves all sentences, and shares fixed weekly controls', async () => {
      const s = await session(),
        text =
          '请每月31日02:30:17，时区America/New_York，整理本会话报表。请分别列出金额和异常。';
      const sent = await sendChatMessage(f.context, f.workspaceId, s.id, {
        clientMessageId: randomUUID(),
        text,
        deliveryMode: 'follow_up',
      });
      const workerId = randomUUID(),
        job = await claimNextJob(workerId, 60000);
      expect(job!.id).toBe(sent.run.job.id);
      const execution = await startClaimedJob(
        workerId,
        job!.id,
        job!.lease!.token,
      );
      const args = { name: '普通月报', prompt: '模型重写不得替代原话', rule },
        input = {
          context: execution!.context,
          sessionId: s.id,
          userMessageId: sent.userMessage.id,
          callId: randomUUID(),
          arguments: args,
          worker: { attempt: job!.attempt, leaseToken: job!.lease!.token },
          ...args,
        };
      const created = await createRecurringTaskFromExecutionContext(input);
      expect(created).toMatchObject({
        prompt: text,
        rule,
        status: 'preparing',
        nextRunAt: null,
      });
      expect((await createRecurringTaskFromExecutionContext(input)).id).toBe(
        created.id,
      );
      const list = await listRecurringTasks(f.context, s.id, {
        clientRequestId: created.clientRequestId,
      });
      expect(list.request).toMatchObject({ prompt: text, rule });
      const fixed = await createRecurringTask(f.context, s.id, {
        clientRequestId: randomUUID(),
        name: '周报',
        prompt: '保留 weekly 原规则',
        rule: {
          kind: 'weekly',
          weekdays: [1, 3, 7],
          time: '09:30:17',
          timezone: 'Asia/Shanghai',
        },
      });
      const controls = await store.loadControls(writer);
      expect(controls).toHaveLength(2);
      expect(controls.find((c) => c.automationId === fixed.id)).toMatchObject({
        kind: 'recurring',
        rule: { kind: 'weekly', weekdays: [1, 3, 7] },
      });
      expect(controls.find((c) => c.automationId === created.id)).toMatchObject(
        { kind: 'calendar', dispatch: { consumer: 'ordinary-monthly-v1' } },
      );
      await failJob({
        workerId,
        jobId: job!.id,
        leaseToken: job!.lease!.token,
        code: 'FIXTURE_DONE',
        message: 'No model requested; SQL assertions complete',
        retryable: false,
      });
    });

    it('applies paused edits without a P/Task, then resumes and proves delete despite a later rejected stale operation', async () => {
      const t = await publicTask();
      const first = await sqlBinding(t.id);
      const pauseId = randomUUID();
      expect(
        await changeRecurringTask(f.context, t.sessionId, t.id, {
          operationId: pauseId,
          expectedRevision: 1,
          action: 'pause',
        }),
      ).toMatchObject({
        status: 'applied',
        task: { status: 'paused', revision: 2 },
      });
      const before = await stateCounts(t.id),
        editId = randomUUID();
      const update = {
        operationId: editId,
        expectedRevision: 2,
        action: 'update' as const,
        name: '已暂停的月报更新',
        prompt: '完整的新内容。仍保持暂停。',
        rule,
      };
      expect(
        await changeRecurringTask(f.context, t.sessionId, t.id, update),
      ).toMatchObject({
        status: 'applied',
        task: { status: 'paused', revision: 3, nextRunAt: null },
      });
      expect(await operation(t, editId)).toMatchObject({
        status: 'applied',
        request: update,
        task: { status: 'paused' },
      });
      expect(await stateCounts(t.id)).toEqual(before);
      expect(before.open_plans).toBe(0);
      const resumeId = randomUUID();
      expect(
        await changeRecurringTask(f.context, t.sessionId, t.id, {
          operationId: resumeId,
          expectedRevision: 3,
          action: 'resume',
        }),
      ).toMatchObject({
        status: 'pending',
        task: { status: 'preparing', revision: 4 },
      });
      const resumed = await sqlBinding(t.id);
      expect(resumed.periodId).not.toBe(first.periodId);
      const periods =
        await f.db`select period_id,business_scheduled_for from allrice_native_calendar_periods where automation_id=${t.id}`;
      expect(periods).toHaveLength(2);
      expect(periods[0]!.business_scheduled_for).toEqual(
        periods[1]!.business_scheduled_for,
      );
      // A canceled old revision can finish native delivery without occupying
      // the resumed immutable period's receipt or queueing business work.
      await first.receipt();
      const [late] =
        await f.db`select outbox_state from allrice_native_recurring_occurrences where calendar_period_id=${first.periodId}`;
      expect(late!.outbox_state).toBe('blocked');
      expect(
        await f.db`select id from allrice_automation_runs where automation_id=${t.id}`,
      ).toHaveLength(0);
      for (
        let i = 0;
        i < 8 && (await operation(t, resumeId)).status === 'pending';
        i++
      )
        await materializeNativeCalendar(calendar(), writer, reference);
      expect(await operation(t, resumeId)).toMatchObject({
        status: 'applied',
        task: { status: 'enabled' },
      });
      const deleteA = randomUUID(),
        deleteB = randomUUID();
      expect(
        await changeRecurringTask(f.context, t.sessionId, t.id, {
          operationId: deleteA,
          expectedRevision: 4,
          action: 'delete',
        }),
      ).toMatchObject({
        status: 'pending',
        task: { status: 'deleting', revision: 5 },
      });
      expect(
        await changeRecurringTask(f.context, t.sessionId, t.id, {
          operationId: deleteB,
          expectedRevision: 4,
          action: 'delete',
        }),
      ).toMatchObject({ status: 'rejected', task: { status: 'deleting' } });
      await retireSqlTasks(t.id);
      for (
        let i = 0;
        i < 8 && (await operation(t, deleteA)).status === 'pending';
        i++
      )
        await materializeNativeCalendar(calendar(), writer, reference);
      expect(await operation(t, deleteA)).toMatchObject({
        status: 'applied',
        task: { status: 'deleted' },
      });
      expect(await operation(t, deleteB)).toMatchObject({
        status: 'rejected',
        task: { status: 'deleted' },
      });
      expect(await store.loadTaskRecords(writer)).toEqual({});
      expect(
        (await f.db`select * from allrice_native_calendar_arms`).length,
      ).toBeGreaterThan(0);
    });

    it('hands a complete 40000-unit original request through real chat Run/Job and original no-model claim/admission', async () => {
      const prompt =
        '核对每一笔账目，分别列出异常。'
          .repeat(2600)
          .slice(0, 39995)
          .padEnd(39995, '米') + '最后汇总。';
      expect(prompt.length).toBe(40000);
      const t = await historicalTask('latest', prompt),
        bound = await sqlBinding(t.id),
        receipt = await bound.receipt();
      expect(await store.commitMutation(writer, receipt)).toBe('committed');
      expect(await dispatchNextNativeRecurringOccurrence(randomUUID())).toBe(
        true,
      );
      const [r] =
        await f.db`select ar.*,j.id job_id,er.prompt_snapshot from allrice_automation_runs ar join allrice_jobs j on j.run_id=ar.run_id
      join allrice_employee_runs er on er.run_id=ar.run_id where ar.automation_id=${t.id} and ar.manual_request_id is null`;
      expect(r!.scheduled_for).toEqual(t.P);
      expect(r!.session_id).toBe(t.sessionId);
      expect(r!.prompt_snapshot.userRequest).toBe(prompt);
      expect(
        await f.db.begin((tx) => lockNativeOnceJobAdmission(tx, r!.job_id)),
      ).toEqual({ scheduled: true, allowed: true, runId: r!.run_id });
      const workerId = randomUUID(),
        job = await claimNextJob(workerId, 60000);
      expect(job!.id).toBe(r!.job_id);
      expect(
        await startClaimedJob(workerId, job!.id, job!.lease!.token),
      ).not.toBeNull();
      const [frozen] =
        await f.db`select configuration,business_content,business_content_digest from allrice_native_recurring_versions where automation_id=${t.id} and revision=1`;
      expect(frozen!.business_content.prompt).toBe(prompt);
      expect(
        Buffer.byteLength(JSON.stringify(frozen!.configuration)),
      ).toBeLessThan(65536);
      expect(frozen!.configuration).not.toHaveProperty('prompt');
      expect(frozen!.business_content_digest).toBe(
        runtimePolicyDigest(t.content),
      );
      await expect(
        f.db`update allrice_native_recurring_versions set business_content=jsonb_set(business_content,'{prompt}','"silently edited"') where automation_id=${t.id}`,
      ).rejects.toThrow();
      const rollback = Error('permission assertion rollback');
      await expect(
        f.db.begin(async (tx) => {
          await tx`update allrice_memberships set role='viewer' where user_id=${f.ownerId} and organization_id=${f.organizationId}`;
          expect(await lockNativeOnceJobAdmission(tx, r!.job_id)).toEqual({
            scheduled: true,
            allowed: false,
            runId: r!.run_id,
          });
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      expect(await dispatchNextNativeRecurringOccurrence(randomUUID())).toBe(
        false,
      );
      const history = await getRecurringTask(f.context, t.sessionId, t.id);
      expect('occurrences' in history && history.occurrences).toHaveLength(1);
      expect('occurrences' in history && history.occurrences[0]).toMatchObject({
        scheduledAt: t.P.toISOString(),
        runId: r!.run_id,
      });
      await failJob({
        workerId,
        jobId: job!.id,
        leaseToken: job!.lease!.token,
        code: 'FIXTURE_DONE',
        message: 'No model invoked',
        retryable: false,
      });
    });

    it('coalesces old P to only the latest legal missed P, then creates exactly one scheduled paid Run and future N', async () => {
      const t = await historicalTask('old'),
        first = await sqlBinding(t.id);
      await first.receipt();
      expect(await dispatchNextNativeRecurringOccurrence(randomUUID())).toBe(
        true,
      );
      const [coalesced] =
        await f.db`select * from allrice_native_calendar_decisions where period_id=${first.periodId}`;
      expect(coalesced).toMatchObject({
        outcome: 'coalesced',
        automation_run_id: null,
      });
      expect(
        await f.db`select id from allrice_automation_runs where automation_id=${t.id}`,
      ).toHaveLength(0);
      const [latest] =
        await f.db`select * from allrice_native_calendar_plans where period_id=${coalesced!.successor_period_id}`;
      expect(latest!.business_scheduled_for).toEqual(
        latestMonthlyBusinessTarget(rule, new Date(coalesced!.decided_at)),
      );
      expect(latest!.business_scheduled_for > t.P).toBe(true);
      await retireSqlTasks(t.id);
      const second = await sqlBinding(t.id);
      expect(second.periodId).toBe(latest!.period_id);
      await second.receipt();
      expect(await dispatchNextNativeRecurringOccurrence(randomUUID())).toBe(
        true,
      );
      expect(await dispatchNextNativeRecurringOccurrence(randomUUID())).toBe(
        false,
      );
      expect(
        await f.db`select id from allrice_automation_runs where automation_id=${t.id} and manual_request_id is null`,
      ).toHaveLength(1);
      const [decision] =
        await f.db`select * from allrice_native_calendar_decisions where period_id=${second.periodId}`;
      const [next] =
        await f.db`select * from allrice_native_calendar_plans where period_id=${decision!.successor_period_id}`;
      expect(next!.business_scheduled_for).toEqual(
        nextMonthlyBusinessTarget(rule, new Date(decision!.decided_at)),
      );
      expect(
        next!.business_scheduled_for > new Date(decision!.decided_at),
      ).toBe(true);
    });

    it('rejects raw content/digest, family/clock, operation and decision forgeries while retaining fixed NULL content', async () => {
      // SQL deferred fences use the original business calendar, including its
      // seconds and DST semantics, independently of the connection timezone.
      await f.db.begin(async (tx) => {
        await tx`set local time zone 'America/New_York'`;
        for (const [r, after] of [
          [rule, '2027-01-31T07:30:17.000Z'],
          [{ ...rule, monthDay: 8 }, '2026-03-01T00:00:00.000Z'],
          [
            { ...rule, monthDay: 1, time: '01:30:05' },
            '2026-11-01T05:30:05.000Z',
          ],
          [
            { ...rule, time: '10:00:59', timezone: 'Asia/Kathmandu' },
            '2026-02-01T00:00:00.000Z',
          ],
        ] as const) {
          const [calculated] = await tx<
            { target: Date; latest: Date }[]
          >`select allrice_ordinary_monthly_next(${tx.json(r)},${after}::timestamptz) target,
          allrice_ordinary_monthly_latest(${tx.json(r)},${after}::timestamptz) latest`;
          expect(calculated!.target).toEqual(
            nextMonthlyBusinessTarget(r, new Date(after)),
          );
          expect(calculated!.latest).toEqual(
            latestMonthlyBusinessTarget(r, new Date(after)),
          );
        }
        const unicode = '🍚'.repeat(20000),
          [length] = await tx<
            { units: string }[]
          >`select allrice_native_calendar_utf16_length(${unicode}) units`;
        expect(Number(length!.units)).toBe(unicode.length);
      });
      const t = await publicTask(),
        [v] =
          await f.db`select * from allrice_native_recurring_versions where automation_id=${t.id}`;
      const altered = {
        ...v!.configuration,
        contentDigest: nativeOnceDigest('wrong content'),
      };
      await expect(f.db`insert into allrice_native_recurring_versions(automation_id,revision,configuration,business_content,business_content_digest)
      values(${t.id},2,${f.db.json({ ...altered, revision: 2 })},${f.db.json(v!.business_content)},${altered.contentDigest})`).rejects.toMatchObject(
        { code: '23514' },
      );
      await expect(f.db`update allrice_automations set clock_owner='legacy',native_recurring_request_id=null,native_recurring_request_digest=null,
      native_recurring_revision=null,native_recurring_resume_after=null where id=${t.id}`).rejects.toMatchObject(
        { code: 'P1921' },
      );
      const fixed = await createRecurringTask(f.context, t.sessionId, {
        clientRequestId: randomUUID(),
        name: '固定周报',
        prompt: '只保留 fixed 路径',
        rule: {
          kind: 'weekly',
          weekdays: [2, 7],
          time: '09:30:17',
          timezone: 'Asia/Shanghai',
        },
      });
      const [fixedV] =
        await f.db`select business_content,business_content_digest from allrice_native_recurring_versions where automation_id=${fixed.id}`;
      expect(fixedV).toMatchObject({
        business_content: null,
        business_content_digest: null,
      });
      await expect(
        f.db`update allrice_native_recurring_versions set business_content=${f.db.json(v!.business_content)} where automation_id=${fixed.id}`,
      ).rejects.toThrow();
      const opId = randomUUID(),
        req = { operationId: opId, expectedRevision: 1, action: 'pause' };
      await expect(f.db`insert into allrice_native_recurring_operations(organization_id,owner_id,operation_id,automation_id,request,request_digest,status)
      values(${f.organizationId},${f.ownerId},${opId},${t.id},${f.db.json(req)},${runtimePolicyDigest({ sessionId: t.sessionId, taskId: t.id, input: req })},'applied')`).rejects.toMatchObject(
        { code: '23514' },
      );
      const [plan] =
        await f.db`select * from allrice_native_calendar_plans where automation_id=${t.id}`;
      const id = randomUUID(),
        at = new Date().toISOString(),
        decision = {
          decisionId: id,
          periodId: plan!.period_id,
          kind: 'authority',
          outcome: 'authority_blocked',
          revision: 1,
          decidedAt: at,
          receiptOccurrenceId: null,
          automationRunId: null,
          successorPeriodId: null,
          lease: null,
          budget: null,
        };
      await expect(
        f.db.begin(async (tx) => {
          await tx`update allrice_automations set status='paused',next_run_at=null where id=${t.id}`;
          await tx`insert into allrice_native_calendar_decisions(decision_id,period_id,kind,outcome,revision,decision,decision_digest,decided_at)
        values(${id},${plan!.period_id},'authority','authority_blocked',1,${tx.json(decision)},${nativeOnceDigest(decision)},${at}::timestamptz)`;
        }),
      ).rejects.toMatchObject({ code: 'P1921' });
      expect((await stateCounts(t.id)).open_plans).toBe(1);
    });
  },
);
