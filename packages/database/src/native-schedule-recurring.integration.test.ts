import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createP27CodexWorkerFixture } from '../../../scripts/acceptance/runtime/p27-codex-worker-fixture.ts';
import { createChatSession, sendChatMessage } from './workspace/service.ts';
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
import { listAutomations } from './execution/automation.ts';
import { claimNextJob, startClaimedJob, failJob } from './execution/queue.ts';
import type { RecurringScheduleRule } from '@allrice/contracts';
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
    async function task(prompt = '核对固定测试数据，只输出本期结果。') {
      const session = await createChatSession(f.context, {
        workspaceId: f.workspaceId,
        employeeAssignmentId: f.assignmentId,
        title: 'Isolated recurring',
      });
      const input = {
        clientRequestId: randomUUID(),
        name: '每期核对',
        prompt,
        rule: { kind: 'every' as const, seconds: 60 },
      };
      const result = await createRecurringTask(f.context, session.id, input);
      const c = (await snapshot(result.id)).control;
      await mutate({ kind: 'session_initializing', controlId: c.controlId });
      await mutate({ kind: 'session_ready', controlId: c.controlId });
      // Explicit synthetic component receipt. Actual timer behavior is separately
      // checked through the public Host and ordinary Dev page.
      const native: NativeRecurringTask = {
        sessionId: c.controlSessionId,
        status: 'active',
        record: {
          id: randomUUID(),
          kind: 'every',
          everySeconds: 60,
          title: 'AllRice once control',
          prompt:
            'Synthetic schedule control only. Never execute business work.',
          scheduledAt: new Date(Date.now() - 180_000).toISOString(),
        },
      };
      await mutate({ kind: 'put_task', controlId: c.controlId, task: native });
      await mutate({
        kind: 'confirm_command',
        controlId: c.controlId,
        commandId: c.command.id,
        nativeTaskId: native.record.id,
      });
      return { id: result.id, sessionId: session.id, input };
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
      // The legacy management DTO cannot parse native recurring rules. Its
      // unchanged entries remain readable; the new panel owns these rows.
      expect(
        (await listAutomations(f.context, f.workspaceId)).automations.some(
          (a) => a.id === t.id,
        ),
      ).toBe(false);
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
