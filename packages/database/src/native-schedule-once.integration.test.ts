import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from 'vitest';
import type { TransactionSql } from 'postgres';
import * as client from './core/client.ts';
import { getDatabase } from './core/client.ts';
import type { RuntimeActionBinding } from '@allrice/contracts';
import { authorizeFixturePlatformAdministrator } from './platform-authority.fixture.ts';
import {
  createRuntimePolicyAdmission,
  requestRuntimeActionApproval,
  setRuntimePolicyControls,
  runtimePolicyDigest,
} from './runtime-policy.ts';
import { maxLeaseLockAttempts } from './queue/lease-lock-retry.ts';
import { createP27CodexWorkerFixture } from '../../../scripts/acceptance/runtime/p27-codex-worker-fixture.ts';
import { createChatSession, sendChatMessage } from './workspace/service.ts';
import {
  employeeManifest,
  employeeManifestChecksum,
} from './employees/employee-config.ts';
import {
  createOnceTask,
  listOnceTasks,
  cancelOnceTask,
  initializeNativeOncePartition,
  lockNativeOnceAdmissions,
  dispatchNextNativeOnceOccurrence,
  createOnceTaskFromExecutionContext,
} from './native-schedule-once-product.ts';
import { createNativeOnceSqlStore } from './native-schedule-once-sql.ts';
import {
  nativeOnceDigest,
  type NativeOnceControl,
  type NativeOnceMutation,
  type NativeOnceTask,
  type NativeOnceWriter,
  type NativeOnceWrite,
} from './native-schedule-once-state.ts';
import { nativeOnceWorkspaceDigest } from './native-schedule-workspace-state.ts';
import { lockNativeOnceJobAdmission } from './native-schedule-once-authority.ts';
import {
  listAutomationCatalog,
  getAutomationCatalogTask,
  changeAutomationCatalogTask,
} from './automation-catalog.ts';
import { updateWorkAutomation } from './work-automation.ts';
import {
  getUserPreferences,
  updateUserPreferences,
} from './user-preferences.ts';
import {
  runManualAutomation,
  getManualAutomationRun,
} from './automation-manual.ts';
import {
  claimNextJob,
  startClaimedJob,
  heartbeatJob,
  failJob,
  completeJob,
  prepareJobNativeSession,
  bindJobNativeSession,
} from './execution/queue.ts';
import { acquireConversationRuntime } from './conversation/conversation-runtime.ts';
import type { NativeSessionLeaseInput } from './conversation/native-session-binding.ts';
import type { NativeRootOrigin } from './conversation/native-root-origin.ts';
import { nativeBindingDescriptor } from './native-session-binding.fixture.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'native once isolated SQL handoff, not a model or native timer acceptance',
  { timeout: 30_000 },
  () => {
    let f: Awaited<ReturnType<typeof createP27CodexWorkerFixture>>;
    let root: string;
    let store: ReturnType<typeof createNativeOnceSqlStore>;
    let writer: NativeOnceWriter;
    let reference: {
      artifactId: string;
      profileId: string;
      storageId: string;
      stateRoot: string;
    };
    const ready = {
      enabled: true,
      storageReady: true,
      legacyClockExcluded: true,
      controlArtifactApproved: true,
    };
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
      vi.stubEnv('ALLRICE_NATIVE_ONCE_ENABLED', '1');
      f = await createP27CodexWorkerFixture({
        allowCiDatabase: true,
        personalProfile: 'writable',
      });
      root = await realpath(await mkdtemp(join(tmpdir(), 'allrice-once-sql-')));
      reference = {
        artifactId: `sha256:${'a'.repeat(64)}`,
        profileId: 'allrice-once-control-v1',
        storageId: 'synthetic-sql-only',
        stateRoot: root,
      };
      vi.stubEnv('ALLRICE_NATIVE_ONCE_REFERENCE', JSON.stringify(reference));
      expect(await initializeNativeOncePartition(reference)).toMatchObject({
        reference,
        activation: ready,
      });
      store = createNativeOnceSqlStore({
        db: f.db,
        partitionId: 'allrice-once-v1',
        ownerId: randomUUID(),
        reference,
        ttlMs: 300_000,
        readiness: () => ready,
        decodeTask: (v) => structuredClone(v) as NativeOnceTask,
        lockAdmission: lockNativeOnceAdmissions,
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
    async function chat() {
      return createChatSession(f.context, {
        workspaceId: f.workspaceId,
        employeeAssignmentId: f.assignmentId,
        title: 'Isolated once',
      });
    }
    async function leasedChat(
      text: string,
      clientMessageId = randomUUID(),
      sessionId?: string,
    ) {
      await f.db`update allrice_jobs set status='canceled' where status='queued'`;
      const c = sessionId ? { id: sessionId } : await chat();
      const submitted = await sendChatMessage(f.context, f.workspaceId, c.id, {
        clientMessageId,
        text,
        deliveryMode: 'follow_up',
      });
      const worker = randomUUID();
      const job = await claimNextJob(worker, 30_000);
      expect(job?.id).toBe(submitted.run.job.id);
      const execution = await startClaimedJob(
        worker,
        job!.id,
        job!.lease!.token,
      );
      return {
        input: {
          context: execution!.context,
          sessionId: c.id,
          userMessageId: submitted.userMessage.id,
          callId: randomUUID(),
          arguments: {
            name: '测试预约',
            prompt: '模型改写不能替代原文',
            delayMinutes: 15,
          },
          worker: { attempt: job!.attempt, leaseToken: job!.lease!.token },
          name: '测试预约',
          prompt: '模型改写不能替代原文',
          delayMinutes: 15,
        },
        finish: () =>
          failJob({
            workerId: worker,
            jobId: job!.id,
            leaseToken: job!.lease!.token,
            code: 'FIXTURE_DONE',
            message: 'Isolated SQL test finished, no model invoked',
            retryable: false,
          }),
        complete: (answer: string) =>
          completeJob({
            workerId: worker,
            jobId: job!.id,
            leaseToken: job!.lease!.token,
            result: { answer },
          }),
      };
    }
    async function task(
      sessionId?: string,
      prompt = '请在原会话回复测试标记。',
      conversationMode?: 'reuse' | 'new_each_run',
    ) {
      const id = sessionId ?? (await chat()).id;
      const input = {
        clientRequestId: randomUUID(),
        name: '小任务',
        prompt,
        runAt: new Date(Date.now() + 6_500).toISOString(),
        timezone: 'Asia/Shanghai',
        ...(conversationMode === undefined ? {} : { conversationMode }),
      };
      return {
        sessionId: id,
        input,
        task: await createOnceTask(f.context, id, input),
      };
    }
    async function mutate(mutation: NativeOnceMutation) {
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
    /** Component boundary fixture: a native receipt value, never claimed as an
     * actual clock firing. The Dev flow separately uses the real public Host. */
    async function preparedReceipt(taskId: string) {
      const [row] = await f.db<
        { snapshot: { control: NativeOnceControl } }[]
      >`select snapshot from allrice_native_once_controls where automation_id=${taskId}`;
      const c = row!.snapshot.control;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, Date.parse(c.at) - Date.now() + 20)),
      );
      await mutate({ kind: 'session_initializing', controlId: c.controlId });
      await mutate({ kind: 'session_ready', controlId: c.controlId });
      const delivery = {
        scheduledAt: c.at,
        deliveredAt: c.at,
        messageId: randomUUID(),
      };
      const nativeTask: NativeOnceTask = {
        sessionId: c.controlSessionId,
        record: {
          id: randomUUID(),
          kind: 'at',
          title: 'AllRice once control',
          prompt:
            'Synthetic schedule control only. Never execute business work.',
          scheduledAt: c.at,
        },
        status: 'inactive',
        lastDelivery: delivery,
        deliveryHistory: {
          records: [
            {
              ...delivery,
              prompt:
                'Synthetic schedule control only. Never execute business work.',
            },
          ],
          earlierRecordsUnavailable: false,
        },
      };
      const mutation: NativeOnceMutation = {
        kind: 'put_task',
        controlId: c.controlId,
        task: nativeTask,
      };
      return { control: c, mutation };
    }
    async function receipt(taskId: string) {
      const { control, mutation } = await preparedReceipt(taskId);
      const write = await mutate(mutation);
      const [receiptRow] =
        await f.db`select outbox_state,outbox_reason from allrice_native_once_occurrences where automation_id=${taskId}`;
      expect(receiptRow).toMatchObject({
        outbox_state: 'pending',
        outbox_reason: null,
      });
      return { control, write };
    }
    it('freezes the session owner preferences when a scheduled occurrence queues its run', async () => {
      const before = await getUserPreferences(f.context);
      onTestFinished(async () => {
        await updateUserPreferences(f.context, {
          questionWait: before.questionWait,
          subagents: before.subagents,
        });
      });
      await updateUserPreferences(f.context, {
        questionWait: { mode: 'default' },
        subagents: { maxDepth: 2, maxActive: 3 },
      });
      const t = await task(undefined, '帮我整理这周的周报，需要的话先问我。');
      // The preference is read at business-run enqueue, not at task creation.
      await updateUserPreferences(f.context, {
        questionWait: { mode: 'timed', seconds: 300 },
        subagents: { maxDepth: 4, maxActive: null },
      });
      await receipt(t.task.id);
      expect(await dispatchNextNativeOnceOccurrence(randomUUID())).toBe(true);
      const snapshot = async () => {
        const [row] = await f.db`
          select r.owner_id, er.execution_snapshot->'nativePreferences' preferences
          from allrice_automation_runs ar join allrice_runs r on r.id=ar.run_id
          join allrice_employee_runs er on er.run_id=ar.run_id
          where ar.automation_id=${t.task.id}`;
        return row;
      };
      const expected = {
        owner_id: f.context.actor.id,
        preferences: {
          version: 1,
          questionWait: { mode: 'timed', seconds: 300 },
          // The valid policy has no delegation rule; preserve the owner's preference.
          subagents: { maxDepth: 4, maxActive: null },
        },
      };
      expect(await snapshot()).toEqual(expected);
      await updateUserPreferences(f.context, {
        questionWait: { mode: 'forever' },
        subagents: { maxDepth: null, maxActive: 8 },
      });
      expect(await snapshot()).toEqual(expected);
    });
    it.each(['reuse', 'new_each_run'] as const)(
      'conversation once parent rejects a pointerless new NULL snapshot at COMMIT (%s)',
      async (conversationMode) => {
        const t = await task(undefined, undefined, conversationMode);
        const arId = randomUUID();
        let reachedCommit = false;
        await expect(
          f.db.begin(async (tx) => {
            const [born] = await tx`insert into allrice_automation_runs
              (id,organization_id,workspace_id,automation_id,session_id,scheduled_for,status)
              values(${arId},${f.organizationId},${f.workspaceId},${t.task.id},${t.sessionId},clock_timestamp(),'queued')
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

    it.each(['reuse', 'new_each_run'] as const)(
      'conversation once %s is frozen at create, targets the real queue and remains revision1',
      async (conversationMode) => {
        const t = await task(
          undefined,
          '一次性核对，只输出本轮结果。',
          conversationMode,
        );
        const [before] =
          await f.db`select to_jsonb(c) control from allrice_native_once_controls c where automation_id=${t.task.id}`;
        expect(await createOnceTask(f.context, t.sessionId, t.input)).toEqual(
          t.task,
        );
        expect(t.task.conversationMode).toBe(conversationMode);
        const changed = conversationMode === 'reuse' ? 'new_each_run' : 'reuse';
        await expect(
          f.db`update allrice_automations set conversation_mode=${changed} where id=${t.task.id}`,
        ).rejects.toMatchObject({ code: '23514' });
        await expect(
          changeAutomationCatalogTask(f.context, f.workspaceId, t.task.id, {
            action: 'conversation',
            operationId: randomUUID(),
            expectedRevision: 1,
            conversationMode: changed,
          }),
        ).rejects.toThrow();
        expect(
          (
            await f.db`select to_jsonb(c) control from allrice_native_once_controls c where automation_id=${t.task.id}`
          )[0],
        ).toEqual(before);
        await receipt(t.task.id);
        await dispatchNextNativeOnceOccurrence(randomUUID());
        const [ar] =
          await f.db`select ar.*,j.id job_id,er.session_id employee_session,
        allrice_automation_conversation_handoff_proved(ar.id) proof from allrice_automation_runs ar
        join allrice_jobs j on j.run_id=ar.run_id join allrice_employee_runs er on er.run_id=ar.run_id where ar.automation_id=${t.task.id}`;
        expect(ar).toMatchObject({
          proof: true,
          conversation_snapshot: {
            mode: conversationMode,
            businessRevision: 1,
            sourceSessionId: t.sessionId,
            targetSessionId: ar!.session_id,
          },
        });
        const [timeProof] = await f.db`select
          allrice_automation_conversation_scheduled_target_proved(ar.automation_id,ar.native_once_occurrence_id,
            ar.native_recurring_occurrence_id,ar.scheduled_for) exact_p,
          allrice_automation_conversation_scheduled_target_proved(ar.automation_id,ar.native_once_occurrence_id,
            ar.native_recurring_occurrence_id,ar.scheduled_for+interval '1 second') wrong_p
          from allrice_automation_runs ar where ar.id=${ar!.id}`;
        expect(timeProof).toEqual({ exact_p: true, wrong_p: false });
        expect(ar!.employee_session).toBe(ar!.session_id);
        if (conversationMode === 'reuse')
          expect(ar!.session_id).toBe(t.sessionId);
        else expect(ar!.session_id).not.toBe(t.sessionId);
        expect(
          await f.db.begin((tx) => lockNativeOnceJobAdmission(tx, ar!.job_id)),
        ).toMatchObject({ allowed: true });
        const projection = (
          await listOnceTasks(f.context, t.sessionId, {
            clientRequestId: t.input.clientRequestId,
          })
        ).tasks[0]!;
        expect(projection).toMatchObject({
          sessionId: t.sessionId,
          resultSessionId: ar!.session_id,
          conversationMode,
        });
        expect(await createOnceTask(f.context, t.sessionId, t.input)).toEqual(
          projection,
        );
        expect(
          Number(
            (
              await f.db`select revision from allrice_automations where id=${t.task.id}`
            )[0]!.revision,
          ),
        ).toBe(1);
        await f.db`update allrice_chat_sessions set archived_at=clock_timestamp() where id=${t.sessionId}`;
        expect(
          await f.db.begin((tx) => lockNativeOnceJobAdmission(tx, ar!.job_id)),
        ).toMatchObject({ allowed: false });
        await f.db`update allrice_chat_sessions set archived_at=null where id=${t.sessionId}`;
      },
    );
    it('manual execution preserves a native once target and cancellation forbids only new manual requests', async () => {
      const t = await task();
      const boundary = async () => ({
        plan: (
          await f.db`select to_jsonb(a) data from allrice_automations a where id=${t.task.id}`
        )[0]!.data,
        control: (
          await f.db`select to_jsonb(c) data from allrice_native_once_controls c where automation_id=${t.task.id}`
        )[0]!.data,
        journal:
          await f.db`select * from allrice_native_once_journal where control_id=(select control_id from allrice_native_once_controls where automation_id=${t.task.id}) order by write_id`,
        occurrences:
          await f.db`select * from allrice_native_once_occurrences where automation_id=${t.task.id}`,
      });
      const before = await boundary(),
        input = { requestId: randomUUID(), expectedRevision: 1 },
        manual = await runManualAutomation(
          f.context,
          f.workspaceId,
          t.task.id,
          input,
        );
      expect(await boundary()).toEqual(before);
      expect(
        (await getAutomationCatalogTask(f.context, f.workspaceId, t.task.id))
          .occurrences[0],
      ).toMatchObject({
        id: manual.automationRunId,
        source: { kind: 'manual', requestId: input.requestId },
      });
      await cancelOnceTask(f.context, t.sessionId, t.task.id);
      const canceled = await boundary();
      await expect(
        runManualAutomation(f.context, f.workspaceId, t.task.id, {
          requestId: randomUUID(),
          expectedRevision: 1,
        }),
      ).rejects.toMatchObject({ code: 'unavailable' });
      expect(
        (
          await getManualAutomationRun(
            f.context,
            f.workspaceId,
            t.task.id,
            input.requestId,
          )
        ).run.id,
      ).toBe(manual.run.id);
      expect(
        (await runManualAutomation(f.context, f.workspaceId, t.task.id, input))
          .run.id,
      ).toBe(manual.run.id);
      expect(await boundary()).toEqual(canceled);
    });
    async function counts() {
      const [row] =
        await f.db`select (select count(*)::int from allrice_messages) messages,
      (select count(*)::int from allrice_employee_runs) employee_runs,(select count(*)::int from allrice_runs) runs,
      (select count(*)::int from allrice_jobs) jobs,(select count(*)::int from allrice_automation_runs) automation_runs,
      (select count(*)::int from allrice_automations) automations,
      (select count(*)::int from allrice_native_once_controls) once_controls`;
      return row;
    }
    async function cloud(enabled: boolean) {
      const [row] =
        await f.db`select revision from allrice_member_work_automation where organization_id=${f.organizationId} and workspace_id=${f.workspaceId} and user_id=${f.ownerId}`;
      return updateWorkAutomation(
        f.context,
        f.workspaceId,
        { expectedRevision: row?.revision ?? 0, capability: 'cloud', enabled },
        f.db,
      );
    }
    async function runningOnce(prompt?: string) {
      // These are only jobs in this fixture's owned schema. Other tests may
      // leave a queued synthetic receipt; the next claim must belong to us.
      await f.db`update allrice_jobs set status='canceled' where status='queued'`;
      const a = await task(undefined, prompt);
      await receipt(a.task.id);
      expect(await dispatchNextNativeOnceOccurrence(randomUUID())).toBe(true);
      const exact = await listOnceTasks(f.context, a.sessionId, {
        clientRequestId: a.input.clientRequestId,
      });
      const runId = exact.tasks[0]!.runId!;
      expect(runId).not.toBeNull();
      const workerId = randomUUID();
      const job = await claimNextJob(workerId, 60_000);
      expect(job?.lease).toBeTruthy();
      const [claimed] =
        await f.db`select run_id from allrice_jobs where id=${job!.id}`;
      expect(claimed!.run_id).toBe(runId);
      const started = await startClaimedJob(
        workerId,
        job!.id,
        job!.lease!.token,
      );
      expect(started?.context.runId).toBe(runId);
      return { ...a, runId, workerId, job: job!, context: started!.context };
    }
    async function nativeInput(r: Awaited<ReturnType<typeof runningOnce>>) {
      const [source] = await f.db<
        {
          config_checksum: string;
          native_root_origin: NativeRootOrigin | null;
        }[]
      >`select v.config_checksum,s.native_root_origin from allrice_employee_runs er
        join allrice_employee_versions v on v.id=er.employee_version_id
        join allrice_chat_sessions s on s.id=er.session_id
        where er.run_id=${r.runId}`;
      expect(source).toBeDefined();
      const runtime = await acquireConversationRuntime({
        organizationId: f.organizationId,
        workspaceId: f.workspaceId,
        ownerId: f.ownerId,
        sessionId: r.sessionId,
        runId: r.runId,
        workerId: r.workerId,
        configChecksum: source!.config_checksum,
        compactThresholdTokens: 8_000,
      });
      const origin = source!.native_root_origin;
      const descriptor = nativeBindingDescriptor({
        organizationId: f.organizationId,
        workspaceId: f.workspaceId,
        ownerId: f.ownerId,
        contextKey: origin?.rootSeed ?? r.sessionId,
        ...(origin
          ? { distributionGeneration: origin.distributionGeneration }
          : {}),
      });
      if (origin) {
        descriptor.artifactId = origin.artifactId;
        descriptor.artifactManifestDigest = origin.artifactId;
        descriptor.profileId = origin.profileId;
      }
      const input: NativeSessionLeaseInput = {
        workerId: r.workerId,
        jobId: r.job.id,
        leaseToken: r.job.lease!.token,
        attempt: r.job.attempt,
        subject: {
          kind: 'chat',
          id: r.sessionId,
          configChecksum: runtime.configChecksum,
          generation: runtime.generation,
          expectedThreadId: runtime.threadId,
        },
        descriptor,
      };
      return input;
    }
    async function nativeStorageSnapshot() {
      const [row] = await f.db`select
        (select jsonb_agg(to_jsonb(p) order by partition_id) from allrice_native_once_partitions p) partitions,
        (select jsonb_agg(to_jsonb(c) order by partition_id,control_id) from allrice_native_once_controls c) controls,
        (select jsonb_agg(to_jsonb(o) order by occurrence_id) from allrice_native_once_occurrences o) occurrences,
        (select jsonb_agg(to_jsonb(j) order by partition_id,write_id) from allrice_native_once_journal j) journal`;
      return row;
    }
    function writerExpiringAtCommit(writeId: string) {
      let commitError: unknown;
      let staged:
        { journal: boolean; lease_live: boolean; expired: boolean } | undefined;
      // Forward the real store callback and every SQL statement. Only after its
      // final active-writer check returns do we shorten the lease and let actual
      // DB wall time pass. PostgreSQL's real COMMIT must reject the journal.
      const db = new Proxy(f.db, {
        get(target, key, receiver) {
          if (key !== 'begin') return Reflect.get(target, key, receiver);
          return async (...args: unknown[]) => {
            const callback = args.at(-1) as (
              tx: TransactionSql,
            ) => Promise<unknown>;
            const forwarded = [...args];
            forwarded[forwarded.length - 1] = async (tx: TransactionSql) => {
              const result = await callback(tx);
              const [before] = await tx<
                { journal: boolean; lease_live: boolean }[]
              >`select
                exists(select 1 from allrice_native_once_journal where write_id=${writeId}) journal,
                expires_at>clock_timestamp() lease_live from allrice_native_once_partitions where partition_id=${writer.partitionId}`;
              await tx`update allrice_native_once_partitions set expires_at=clock_timestamp()+interval '20 milliseconds' where partition_id=${writer.partitionId}`;
              await tx`select pg_sleep(0.04)`;
              const [after] = await tx<
                { expired: boolean }[]
              >`select expires_at<=clock_timestamp() expired
                from allrice_native_once_partitions where partition_id=${writer.partitionId}`;
              staged = { ...before!, expired: after!.expired };
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
      return {
        store: createNativeOnceSqlStore({
          db,
          partitionId: writer.partitionId,
          ownerId: writer.ownerId,
          reference,
          ttlMs: 300_000,
          readiness: () => ready,
          decodeTask: (value) => structuredClone(value) as NativeOnceTask,
          lockAdmission: lockNativeOnceAdmissions,
          proveClosed: async () => null,
        }),
        evidence: () => ({ commitError, staged }),
      };
    }
    async function publishVersion(version: number, tools: string[]) {
      const manifest = employeeManifest({
        key: 'p27-codex-worker',
        name: `Once fixture v${version}`,
        description: 'Isolated SQL boundary only',
        toolNames: tools,
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
      const id = randomUUID();
      await f.db.begin(async (tx) => {
        await tx`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum,manifest,provider_snapshot)
        values(${id},${f.organizationId},${f.workspaceId},${f.employeeId},${version},${manifest.name},${manifest.provider.model},${manifest.systemPrompt},${tx.json(manifest.capabilities)},${employeeManifestChecksum(manifest)},${tx.json(manifest)},${tx.json(manifest.provider)})`;
        await tx`update allrice_employee_assignments set employee_version_id=${id} where id=${f.assignmentId}`;
      });
      return id;
    }
    it('preserves exact identity, rejects changed configuration and does not replace a live writer', async () => {
      const again = await initializeNativeOncePartition(reference);
      expect(again.reference).toEqual(reference);
      await expect(
        initializeNativeOncePartition({ ...reference, storageId: 'different' }),
      ).rejects.toMatchObject({ code: 'binding_conflict' });
      const [p] =
        await f.db`select epoch,closed from allrice_native_once_partitions`;
      expect(Number(p!.epoch)).toBe(1);
      expect(p!.closed).toBe(false);
      expect(await store.acquireWriter()).toBeNull();
    });
    it('returns the original task for an exact request, isolates owner/AI and disables creation when cloud is off', async () => {
      const a = await task();
      expect((await createOnceTask(f.context, a.sessionId, a.input)).id).toBe(
        a.task.id,
      );
      await expect(
        createOnceTask(f.context, a.sessionId, {
          ...a.input,
          prompt: 'changed',
        }),
      ).rejects.toMatchObject({ code: 'request_conflict' });
      const otherChat = await chat();
      const exact = await listOnceTasks(f.context, otherChat.id, {
        clientRequestId: a.input.clientRequestId,
      });
      expect(exact.tasks.map((t) => t.id)).toEqual([a.task.id]);
      expect(exact.nextCursor).toBeNull();
      await expect(
        listOnceTasks(
          { ...f.context, actor: { type: 'user', id: randomUUID() } },
          a.sessionId,
        ),
      ).rejects.toMatchObject({ code: 'not_found' });
      await cloud(false);
      try {
        expect((await listOnceTasks(f.context, a.sessionId)).enabled).toBe(
          false,
        );
        await expect(
          createOnceTask(f.context, a.sessionId, {
            ...a.input,
            clientRequestId: randomUUID(),
          }),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
        expect(
          (await cancelOnceTask(f.context, a.sessionId, a.task.id)).status,
        ).toBe('canceled');
      } finally {
        await cloud(true);
      }
    });
    it('unified catalog includes one-off tasks from all chats and cancels after archive', async () => {
      const a = await task(),
        b = await task();
      const list = await listAutomationCatalog(f.context, {
        workspaceId: f.workspaceId,
      });
      expect(
        list.tasks.some(
          (t) => t.id === a.task.id && t.definition.kind === 'once',
        ),
      ).toBe(true);
      expect(
        list.tasks.some(
          (t) => t.id === b.task.id && t.sessionId === b.sessionId,
        ),
      ).toBe(true);
      await f.db`update allrice_chat_sessions set archived_at=clock_timestamp() where id=${a.sessionId}`;
      await cloud(false);
      try {
        expect(
          (await getAutomationCatalogTask(f.context, f.workspaceId, a.task.id))
            .task,
        ).toMatchObject({ sourceArchived: true, canStop: true });
        expect(
          await changeAutomationCatalogTask(
            f.context,
            f.workspaceId,
            a.task.id,
            { action: 'cancel' },
          ),
        ).toMatchObject({ task: { id: a.task.id, status: 'canceled' } });
      } finally {
        await cloud(true);
      }
    });
    it('keeps older pending entries and exact request lookup beyond the first page', async () => {
      const c = await chat(),
        first = await task(c.id);
      for (let i = 0; i < 51; i++) await task(c.id);
      const page = await listOnceTasks(f.context, c.id);
      expect(page.tasks).toHaveLength(50);
      expect(page.nextCursor).not.toBeNull();
      const next = await listOnceTasks(f.context, c.id, {
        cursor: page.nextCursor!,
      });
      expect(next.tasks.some((t) => t.id === first.task.id)).toBe(true);
      expect(
        new Set([...page.tasks, ...next.tasks].map((t) => t.id)).size,
      ).toBe(page.tasks.length + next.tasks.length);
      expect(
        (
          await listOnceTasks(f.context, c.id, {
            clientRequestId: first.input.clientRequestId,
          })
        ).tasks[0]?.id,
      ).toBe(first.task.id);
      await expect(
        listOnceTasks(f.context, c.id, { cursor: 'invalid' }),
      ).rejects.toThrow();
    }, 60_000);
    it('commits workspace CAS once and rejects altered replay without rewriting the journal', async () => {
      const mutation = {
        kind: 'set_global' as const,
        value: {
          initialized: true,
          workspaceIds: [],
          archivedSessionIds: [],
          pinnedSessionIds: [],
        },
      };
      const write = {
        writeId: randomUUID(),
        expectedRevision: 0,
        mutation,
        digest: nativeOnceWorkspaceDigest(
          {
            entryKind: 'workspace',
            unitVersion: 2,
            expectedRevision: 0,
            mutation,
          },
          true,
        ),
      };
      expect(await store.commitWorkspaceWrite(writer, write)).toEqual({
        revision: 1,
      });
      expect(await store.commitWorkspaceWrite(writer, write)).toEqual({
        revision: 1,
      });
      await expect(
        store.commitWorkspaceWrite(writer, { ...write, expectedRevision: 1 }),
      ).rejects.toThrow();
      await expect(
        f.db`update allrice_native_once_journal set write_digest=${`sha256:${'b'.repeat(64)}`} where write_id=${write.writeId}`,
      ).rejects.toThrow('immutable');
      await expect(
        f.db`update allrice_native_once_partitions set workspace_snapshot='{"unitVersion":2}'::jsonb`,
      ).rejects.toThrow();
      const tombstone = await task();
      await f.db`update allrice_native_once_controls
        set snapshot=jsonb_set(snapshot,'{control,taskDeleted}','true'::jsonb),snapshot_version=snapshot_version+1
        where automation_id=${tombstone.task.id}`;
      await expect(
        f.db`update allrice_native_once_controls
          set snapshot=snapshot #- '{control,taskDeleted}',snapshot_version=snapshot_version+1
          where automation_id=${tombstone.task.id}`,
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        f.db`update allrice_native_once_controls
          set snapshot=jsonb_set(snapshot,'{control,taskDeleted}','null'::jsonb),snapshot_version=snapshot_version+1
          where automation_id=${tombstone.task.id}`,
      ).rejects.toMatchObject({ code: '23514' });
      const [retained] =
        await f.db`select snapshot->'control'->'taskDeleted' deleted
        from allrice_native_once_controls where automation_id=${tombstone.task.id}`;
      expect(retained!.deleted).toBe(true);
    });
    it('rolls back the control, receipt and journal when writer P1920 expires after the final callback check', async () => {
      const a = await task();
      const { mutation } = await preparedReceipt(a.task.id);
      expect(await store.renewWriter(writer)).not.toBeNull();
      const write: NativeOnceWrite = {
        writeId: randomUUID(),
        mutation,
        digest: nativeOnceDigest(mutation),
      };
      const before = await nativeStorageSnapshot();
      const expiring = writerExpiringAtCommit(write.writeId);
      expect(await expiring.store.commitMutation(writer, write)).toBe(
        'rejected',
      );
      expect(expiring.evidence().staged).toEqual({
        journal: true,
        lease_live: true,
        expired: true,
      });
      expect(expiring.evidence().commitError).toMatchObject({ code: 'P1920' });
      expect(await nativeStorageSnapshot()).toEqual(before);
      expect(await store.readExactCommit(writer, write)).toBe('absent');
      expect(await store.assertWriter(writer)).toBe(true);
    });
    it('rolls back workspace CAS and journal together when writer P1920 expires only at COMMIT', async () => {
      expect(await store.renewWriter(writer)).not.toBeNull();
      const unit = await store.loadWorkspaceUnit(writer);
      const mutation = {
        kind: 'set_global' as const,
        value: {
          initialized: true,
          workspaceIds: [],
          archivedSessionIds: [],
          pinnedSessionIds: [],
        },
      };
      const write = {
        writeId: randomUUID(),
        expectedRevision: unit.revision,
        mutation,
        digest: nativeOnceWorkspaceDigest(
          {
            entryKind: 'workspace',
            unitVersion: 2,
            expectedRevision: unit.revision,
            mutation,
          },
          true,
        ),
      };
      const before = await nativeStorageSnapshot();
      const expiring = writerExpiringAtCommit(write.writeId);
      await expect(
        expiring.store.commitWorkspaceWrite(writer, write),
      ).rejects.toMatchObject({ code: 'P1920' });
      expect(expiring.evidence().staged).toEqual({
        journal: true,
        lease_live: true,
        expired: true,
      });
      expect(expiring.evidence().commitError).toMatchObject({ code: 'P1920' });
      expect(await nativeStorageSnapshot()).toEqual(before);
      expect(await store.loadWorkspaceUnit(writer)).toEqual(unit);
      expect(await store.assertWriter(writer)).toBe(true);
    });
    it('rolls back messages, Run and Job when the final COMMIT consumer lease expires', async () => {
      const a = await task();
      await receipt(a.task.id);
      const before = await counts();
      await f.db
        .unsafe(`create function once_expire_fixture() returns trigger language plpgsql as $$ begin
      update allrice_native_once_occurrences set outbox_expires_at=clock_timestamp()-interval '1 second' where occurrence_id=new.native_once_occurrence_id;
      return new; end $$; create trigger once_expire_fixture before insert on allrice_automation_runs for each row execute function once_expire_fixture()`);
      try {
        await expect(
          dispatchNextNativeOnceOccurrence(randomUUID()),
        ).rejects.toMatchObject({ code: 'P1921' });
      } finally {
        await f.db.unsafe(
          'drop trigger once_expire_fixture on allrice_automation_runs; drop function once_expire_fixture()',
        );
      }
      expect(await counts()).toEqual(before);
      const [o] =
        await f.db`select outbox_state,business_binding from allrice_native_once_occurrences where automation_id=${a.task.id}`;
      expect(o).toMatchObject({
        outbox_state: 'pending',
        business_binding: null,
      });
      await f.db`update allrice_native_once_occurrences set outbox_expires_at=clock_timestamp()-interval '1 second' where automation_id=${a.task.id}`;
      expect(await dispatchNextNativeOnceOccurrence(randomUUID())).toBe(true);
      const result = (
        await listOnceTasks(f.context, a.sessionId, {
          clientRequestId: a.input.clientRequestId,
        })
      ).tasks[0]!;
      expect(result.status).toBe('queued');
      expect(result.runId).not.toBeNull();
      expect(result.canCancel).toBe(false);
      expect(
        (await cancelOnceTask(f.context, a.sessionId, a.task.id)).runId,
      ).toBe(result.runId);
      expect(await dispatchNextNativeOnceOccurrence(randomUUID())).toBe(false);
      const [bound] =
        await f.db`select business_binding from allrice_native_once_occurrences where automation_id=${a.task.id}`;
      expect(
        await f.db.begin((tx) =>
          lockNativeOnceJobAdmission(tx, bound!.business_binding.jobId),
        ),
      ).toMatchObject({ scheduled: true, allowed: true });
    }, 30_000);
    it('dispatches concurrent consumers once and preserves exact receipt readback after enrollment is consumed', async () => {
      const a = await task(),
        r = await receipt(a.task.id);
      const attempts = await Promise.all([
        dispatchNextNativeOnceOccurrence(randomUUID()),
        dispatchNextNativeOnceOccurrence(randomUUID()),
      ]);
      expect(attempts.filter(Boolean)).toHaveLength(1);
      expect(await store.readExactCommit(writer, r.write)).toBe('committed');
      expect(await store.commitMutation(writer, r.write)).toBe('committed');
      expect(
        await f.db`select run_id from allrice_automation_runs where automation_id=${a.task.id}`,
      ).toHaveLength(1);
      expect(
        (await createOnceTask(f.context, a.sessionId, a.input)).runId,
      ).not.toBeNull();
    });
    it('does not enqueue again after the real business COMMIT succeeds but its ACK is lost', async () => {
      const a = await task();
      const r = await receipt(a.task.id);
      const before = await counts();
      const db = getDatabase();
      const begin = db.begin.bind(db);
      const lostAck = new Error('isolated fixture: business COMMIT ACK lost');
      let commits = 0;
      // Keep both real transactions and all production SQL. The second begin
      // promise resolves only after PostgreSQL COMMIT ACK, then this caller loses
      // that return value. No response or transaction result is fabricated.
      const wrapped = (async (...args: unknown[]) => {
        const result: unknown = await Reflect.apply(begin, db, args);
        commits++;
        if (commits === 2) throw lostAck;
        return result;
      }) as typeof db.begin;
      const drop = vi.spyOn(db, 'begin').mockImplementation(wrapped);
      try {
        await expect(
          dispatchNextNativeOnceOccurrence(randomUUID()),
        ).rejects.toBe(lostAck);
      } finally {
        drop.mockRestore();
      }
      expect(commits).toBe(2);
      const committed = await counts();
      expect(committed).toEqual({
        ...before,
        messages: before!.messages + 2,
        employee_runs: before!.employee_runs + 1,
        runs: before!.runs + 1,
        jobs: before!.jobs + 1,
        automation_runs: before!.automation_runs + 1,
      });
      const [binding] = await f.db`select outbox_state,business_binding
        from allrice_native_once_occurrences where automation_id=${a.task.id}`;
      expect(binding!.outbox_state).toBe('enqueued');
      expect(binding!.business_binding.runId).toBeTruthy();
      const exact = await listOnceTasks(f.context, a.sessionId, {
        clientRequestId: a.input.clientRequestId,
      });
      expect(exact.tasks[0]?.runId).toBe(binding!.business_binding.runId);
      expect(await store.readExactCommit(writer, r.write)).toBe('committed');
      expect(await dispatchNextNativeOnceOccurrence(randomUUID())).toBe(false);
      expect(
        (await createOnceTask(f.context, a.sessionId, a.input)).runId,
      ).toBe(binding!.business_binding.runId);
      expect(await counts()).toEqual(committed);
    });
    it('serializes pending cancellation against dispatch without a canceled task also gaining a Run', async () => {
      const a = await task();
      await receipt(a.task.id);
      await Promise.all([
        cancelOnceTask(f.context, a.sessionId, a.task.id),
        dispatchNextNativeOnceOccurrence(randomUUID()),
      ]);
      const result = (
        await listOnceTasks(f.context, a.sessionId, {
          clientRequestId: a.input.clientRequestId,
        })
      ).tasks[0]!;
      expect(['canceled', 'queued']).toContain(result.status);
      expect(result.runId === null).toBe(result.status === 'canceled');
      expect(
        await f.db`select run_id from allrice_automation_runs where automation_id=${a.task.id}`,
      ).toHaveLength(result.runId ? 1 : 0);
    });
    it('records permission loss as not executed without reading into a business handoff', async () => {
      const a = await task();
      await receipt(a.task.id);
      const before = await counts();
      await cloud(false);
      try {
        expect(await dispatchNextNativeOnceOccurrence(randomUUID())).toBe(true);
        expect(await counts()).toEqual(before);
        expect(
          (
            await listOnceTasks(f.context, a.sessionId, {
              clientRequestId: a.input.clientRequestId,
            })
          ).tasks[0]?.status,
        ).toBe('not_executed');
      } finally {
        await cloud(true);
      }
    });
    it('rechecks queued work at start and running work at heartbeat through ordinary cancellation', async () => {
      // Finish only synthetic prior queued jobs so this test owns the next claim.
      await f.db`update allrice_jobs set status='canceled' where status='queued'`;
      const a = await task();
      await receipt(a.task.id);
      await dispatchNextNativeOnceOccurrence(randomUUID());
      const worker = randomUUID(),
        job = await claimNextJob(worker, 30_000);
      expect(job?.lease).toBeTruthy();
      await cloud(false);
      try {
        await expect(
          startClaimedJob(worker, job!.id, job!.lease!.token),
        ).rejects.toMatchObject({ code: 'policy_denied' });
      } finally {
        await cloud(true);
      }
      const b = await task();
      await receipt(b.task.id);
      await dispatchNextNativeOnceOccurrence(randomUUID());
      const running = await claimNextJob(worker, 30_000);
      expect(running?.lease).toBeTruthy();
      expect(
        await startClaimedJob(worker, running!.id, running!.lease!.token),
      ).not.toBeNull();
      await cloud(false);
      try {
        expect(
          await heartbeatJob(
            worker,
            running!.id,
            running!.lease!.token,
            30_000,
          ),
        ).toMatchObject({ active: false, canceled: true });
        const [cutoff] =
          await f.db`select cancel_requested_at,cancel_reason from allrice_jobs where id=${running!.id}`;
        expect(cutoff!.cancel_requested_at).not.toBeNull();
        expect(cutoff!.cancel_reason).toBe('native_schedule_authority_revoked');
      } finally {
        await cloud(true);
      }
    });
    it.each([
      { method: 'prepare', revoked: 'cloud' },
      { method: 'bind', revoked: 'cloud' },
      { method: 'prepare', revoked: 'membership' },
      { method: 'bind', revoked: 'membership' },
    ] as const)(
      'rejects once $method after $revoked loss and commits its cancellation',
      async ({ method, revoked }) => {
        const r = await runningOnce();
        const input = await nativeInput(r);
        const preparation = {
          workerId: input.workerId,
          jobId: input.jobId,
          leaseToken: input.leaseToken,
          attempt: input.attempt,
          subject: input.subject,
          nativeSessionId: input.descriptor.nativeSessionId,
          storageContextKey: input.descriptor.storageContextKey,
        };
        // Positive controls exercise the actual binder and re-admission before
        // revocation, so an invalid descriptor cannot explain the later rejection.
        const bound = await bindJobNativeSession(input);
        expect(bound.binding.nativeSessionId).toBe(
          input.descriptor.nativeSessionId,
        );
        expect((await prepareJobNativeSession(preparation)).binding).toEqual(
          bound.binding,
        );
        const [pin] =
          await f.db`select * from allrice_native_session_bindings where native_session_id=${input.descriptor.nativeSessionId}`;
        const membership = f.context.memberships[0]!;
        if (revoked === 'cloud') await cloud(false);
        else
          await f.db`update allrice_memberships set role='viewer' where id=${membership.id}`;
        try {
          // The browser context still carries its old role; Worker admission must
          // use current rows instead of trusting that saved membership list.
          expect(membership.role).toBe('admin');
          await expect(
            method === 'prepare'
              ? prepareJobNativeSession(preparation)
              : bindJobNativeSession(input),
          ).rejects.toMatchObject({ code: 'NATIVE_SESSION_ADMISSION_DENIED' });
          const [cutoff] =
            await f.db`select status,cancel_requested_at,cancel_reason from allrice_jobs where id=${r.job.id}`;
          expect(cutoff!.cancel_requested_at).not.toBeNull();
          expect(cutoff!.cancel_reason).toBe(
            'native_schedule_authority_revoked',
          );
          expect(
            (
              await f.db`select * from allrice_native_session_bindings where native_session_id=${input.descriptor.nativeSessionId}`
            )[0],
          ).toEqual(pin);
        } finally {
          if (revoked === 'cloud') await cloud(true);
          else
            await f.db`update allrice_memberships set role=${membership.role} where id=${membership.id}`;
        }
      },
    );
    it('a lease-bounded heartbeat retry passes its lock budget into once admission', async () => {
      const r = await runningOnce();
      const effective = (lockWaitMs?: number) =>
        getDatabase().begin(async (tx) => {
          await lockNativeOnceJobAdmission(tx, r.job.id, lockWaitMs);
          const [row] = await tx<
            { value: string }[]
          >`select current_setting('lock_timeout') value`;
          return row!.value;
        });
      // The admission's own lock waits use what the retry has left of its
      // lease (MET-210 #4); the default stays the queue's 5 s.
      await expect(effective()).resolves.toBe('5s');
      await expect(effective(120)).resolves.toBe('120ms');
    });
    it('bounds once heartbeat retries on held 703 and releases authority locks before giving up with 55P03', async () => {
      const r = await runningOnce();
      const [before] =
        await f.db`select heartbeat_at,lease_expires_at,cancel_requested_at from allrice_jobs where id=${r.job.id}`;
      const held = await f.db.reserve();
      await held`select pg_advisory_lock(hashtextextended(${r.runId},703))`;
      try {
        // Each attempt opens its own transaction; while 703 is busy it rolls
        // back, re-reads the lease (its own short transaction) and backs off
        // before the next (MET-210 #4: one lease-bounded loop, original
        // SQLSTATE kept). Count attempts instead of timing them: a slow runner
        // stretches every attempt, but the retries must still stop at the
        // limit. One transaction past attempts + lease reads fails at once.
        const real = getDatabase();
        let transactions = 0;
        const counted = new Proxy(real, {
          get(target, key) {
            if (key !== 'begin') return Reflect.get(target, key, target);
            return (...args: unknown[]) => {
              if (++transactions > 2 * maxLeaseLockAttempts - 1)
                throw new Error('heartbeat retried past its limit');
              return Reflect.apply(target.begin, target, args);
            };
          },
        });
        const spy = vi.spyOn(client, 'getDatabase').mockReturnValue(counted);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        // Also restore when a hang ends the test by timeout.
        onTestFinished(() => {
          spy.mockRestore();
          warn.mockRestore();
          error.mockRestore();
        });
        try {
          await expect(
            heartbeatJob(r.workerId, r.job.id, r.job.lease!.token, 60_000),
          ).rejects.toMatchObject({ code: '55P03' });
        } finally {
          spy.mockRestore();
        }
        // One observed record per attempt: every one rolled back on 55P03.
        const attempts = [...warn.mock.calls, ...error.mock.calls]
          .filter(
            ([tag, record]) =>
              tag === '[MET-210] Worker lease transaction rolled back' &&
              record.site === 'job_heartbeat',
          )
          .map(([, record]) => [record.attempt, record.outcome]);
        warn.mockRestore();
        error.mockRestore();
        expect(attempts).toEqual([
          ...Array.from({ length: maxLeaseLockAttempts - 1 }, (_, i) => [
            i + 1,
            'retrying',
          ]),
          [maxLeaseLockAttempts, 'exhausted'],
        ]);
        expect(transactions).toBe(2 * maxLeaseLockAttempts - 1);
        // Keep 703 held: these NOWAIT locks prove that every failed attempt
        // rolled back its principal and target locks instead of parking them.
        await f.db.begin(async (tx) => {
          await tx`select id from allrice_users where id=${f.ownerId} for no key update nowait`;
          await tx`select id from allrice_employee_assignments where id=${f.assignmentId} for update nowait`;
          await tx`select id from allrice_chat_sessions where id=${r.sessionId} for update nowait`;
        });
        expect(
          (
            await f.db`select heartbeat_at,lease_expires_at,cancel_requested_at from allrice_jobs where id=${r.job.id}`
          )[0],
        ).toEqual(before);
      } finally {
        try {
          await held`select pg_advisory_unlock(hashtextextended(${r.runId},703))`;
        } finally {
          held.release();
        }
      }
      expect(
        await heartbeatJob(r.workerId, r.job.id, r.job.lease!.token, 60_000),
      ).toEqual({ active: true, canceled: false });
    });
    it('enrolls only from a real leased chat call and replays the original relative time', async () => {
      await f.db`update allrice_jobs set status='canceled' where status='queued'`;
      await publishVersion(2, ['automation.create']);
      const c = await chat();
      const submitted = await sendChatMessage(f.context, f.workspaceId, c.id, {
        clientMessageId: randomUUID(),
        text: '一分钟后在此对话回复测试标记。',
        deliveryMode: 'follow_up',
      });
      const worker = randomUUID(),
        job = await claimNextJob(worker, 30_000);
      expect(job?.id).toBe(submitted.run.job.id);
      const execution = await startClaimedJob(
        worker,
        job!.id,
        job!.lease!.token,
      );
      expect(execution?.context.runId).toBe(submitted.run.id);
      const input = {
        context: execution!.context,
        sessionId: c.id,
        userMessageId: submitted.userMessage.id,
        callId: randomUUID(),
        arguments: {
          name: '真实调用边界',
          prompt: '回复测试标记。',
          delayMinutes: 1,
        },
        worker: { attempt: job!.attempt, leaseToken: job!.lease!.token },
        name: '真实调用边界',
        prompt: '回复测试标记。',
        delayMinutes: 1,
      };
      const first = await createOnceTaskFromExecutionContext(input);
      expect(first.prompt).toBe(input.prompt);
      expect(first.runId).toBeNull();
      expect(first.sessionId).toBe(c.id);
      expect(await createOnceTaskFromExecutionContext(input)).toEqual(first);
      await expect(
        createOnceTaskFromExecutionContext({ ...input, prompt: '不同内容' }),
      ).rejects.toMatchObject({ code: 'request_conflict' });
      await expect(
        createOnceTaskFromExecutionContext({
          ...input,
          worker: { ...input.worker, leaseToken: randomUUID() },
        }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await expect(
        createOnceTaskFromExecutionContext({
          ...input,
          sessionId: (await chat()).id,
        }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      expect((await cancelOnceTask(f.context, c.id, first.id)).status).toBe(
        'canceled',
      );
      await failJob({
        workerId: worker,
        jobId: job!.id,
        leaseToken: job!.lease!.token,
        code: 'FIXTURE_DONE',
        message: 'SQL boundary verified',
        retryable: false,
      });
    });
    it.each([
      '半小时后提醒我喝水。',
      '帮忙设一下：1分钟后提醒我“喝水”。',
      '文档示例：不要创建任务。',
      '只有我以后确认了才提醒。',
      '是的',
    ])(
      'uses valid model parameters without interpreting source wording: %s',
      async (text) => {
        const r = await leasedChat(text);
        const input = {
          ...r.input,
          delayMinutes: 30,
          prompt: '模型参数中的任务内容。\n第二行。',
        };
        try {
          const saved = await createOnceTaskFromExecutionContext(input);
          expect(saved.prompt).toBe(input.prompt);
          expect(saved.prompt).not.toBe(text);
          expect(saved.runAt).toBeTruthy();
          expect(await createOnceTaskFromExecutionContext(input)).toEqual(
            saved,
          );
          await expect(
            createOnceTaskFromExecutionContext({
              ...input,
              prompt: '不同内容',
            }),
          ).rejects.toMatchObject({ code: 'request_conflict' });
          expect(
            (await cancelOnceTask(f.context, input.sessionId, saved.id)).status,
          ).toBe('canceled');
        } finally {
          await r.finish();
        }
      },
    );
    it.each([0, -1, 1.5, 525_601, Number.MAX_SAFE_INTEGER + 1])(
      'rejects illegal delay parameters after removal of wording checks: %s',
      async (delayMinutes) => {
        const r = await leasedChat('半小时后提醒我喝水。');
        try {
          const before = await counts();
          await expect(
            createOnceTaskFromExecutionContext({ ...r.input, delayMinutes }),
          ).rejects.toMatchObject({ code: 'authorization_denied' });
          expect(await counts()).toEqual(before);
        } finally {
          await r.finish();
        }
      },
    );
    it('rejects assistant-message and foreign organization inputs before enrollment', async () => {
      const r = await leasedChat('半小时后提醒我喝水。');
      try {
        const [messages] =
          await f.db`select assistant_message_id from allrice_employee_runs where run_id=${r.input.context.runId}`;
        const before = await counts();
        await expect(
          createOnceTaskFromExecutionContext({
            ...r.input,
            userMessageId: messages!.assistant_message_id,
          }),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
        await expect(
          createOnceTaskFromExecutionContext({
            ...r.input,
            context: { ...r.input.context, organizationId: randomUUID() },
          }),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
        expect(await counts()).toEqual(before);
      } finally {
        await r.finish();
      }
    });
    it('rejects a real system message even when its text and leased chat identity otherwise match', async () => {
      const r = await leasedChat('半小时后提醒我喝水。');
      try {
        await f.db`update allrice_messages set role='system' where id=${r.input.userMessageId}`;
        const before = await counts();
        await expect(
          createOnceTaskFromExecutionContext(r.input),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
        expect(await counts()).toEqual(before);
      } finally {
        await f.db`update allrice_messages set role='user' where id=${r.input.userMessageId}`;
        await r.finish();
      }
    });
    it('rejects an independently linked SQL child Run, distinct from native DSH children', async () => {
      const parent = await leasedChat('父任务');
      const child = await leasedChat('半小时后提醒我喝水。');
      const parentId = parent.input.context.runId,
        childId = child.input.context.runId;
      const previous =
        await f.db`select * from allrice_runtime_run_links where run_id=${childId}`;
      try {
        await f.db`insert into allrice_runtime_roots(root_run_id,organization_id,workspace_id,task,deadline_at)
          values(${parentId},${f.organizationId},${f.workspaceId},'{}',clock_timestamp()+interval '1 hour') on conflict do nothing`;
        await f.db`insert into allrice_runtime_run_links(run_id,root_run_id,parent_run_id,organization_id,workspace_id,task)
          values(${parentId},${parentId},null,${f.organizationId},${f.workspaceId},'{}') on conflict do nothing`;
        await f.db`delete from allrice_runtime_run_links where run_id=${childId}`;
        await f.db`insert into allrice_runtime_run_links(run_id,root_run_id,parent_run_id,organization_id,workspace_id,task)
          values(${childId},${parentId},${parentId},${f.organizationId},${f.workspaceId},'{}')`;
        const before = await counts();
        await expect(
          createOnceTaskFromExecutionContext(child.input),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
        expect(await counts()).toEqual(before);
      } finally {
        await f.db`delete from allrice_runtime_run_links where run_id=${childId}`;
        if (previous.length)
          await f.db`insert into allrice_runtime_run_links ${f.db(previous)}`;
        await child.finish();
        await parent.finish();
      }
    });
    it('keeps a real due Run behind ordinary exact approval and current target authority', async () => {
      vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
      const r = await runningOnce(
        '到点后删除指定的测试文件，须依现有规则确认。',
      );
      const target = randomUUID(),
        device = randomUUID(),
        grant = randomUUID();
      try {
        const [run] =
          await f.db`select r.execution_spec,p.payload from allrice_runs r
          join allrice_policy_snapshots p on p.id=r.policy_snapshot_id where r.id=${r.runId}`;
        await f.db`insert into allrice_execution_targets(id,organization_id,workspace_id,target_key,kind,label,state,capabilities,concurrency_limit,timeout_seconds)
          values(${target},${f.organizationId},${f.workspaceId},${'once-approval-' + target},'rice_bridge','Synthetic delete target','online','[]',1,60)`;
        await f.db`insert into allrice_bridge_devices(id,organization_id,workspace_id,owner_id,name,platform,protocol_version,capabilities,token_hash)
          values(${device},${f.organizationId},${f.workspaceId},${f.ownerId},'Synthetic only','macos-x64',2,array['local.fs.write'],${'b'.repeat(64)})`;
        await f.db`insert into allrice_bridge_folder_grants(id,organization_id,workspace_id,owner_id,device_id,label,root_fingerprint)
          values(${grant},${f.organizationId},${f.workspaceId},${f.ownerId},${device},'Synthetic only',${'a'.repeat(64)})`;
        const binding: RuntimeActionBinding = {
          task: {
            scope: {
              organizationId: f.organizationId,
              workspaceId: f.workspaceId,
              projectId: null,
            },
            chatSessionId: r.sessionId,
            runId: r.runId,
            rootRunId: r.runId,
            parentRunId: null,
            frozenConfiguration: {
              employeeVersionId: null,
              digest: runtimePolicyDigest(run!.execution_spec),
            },
          },
          attempt: {
            operationId: randomUUID(),
            attemptId: randomUUID(),
            attemptNumber: 1,
            generation: 0,
            fence: 1,
          },
          requestedBy: { type: 'user', id: f.ownerId },
          policy: {
            snapshotId: r.context.policySnapshot.id,
            digest: runtimePolicyDigest(run!.payload),
          },
          execution: {
            targetId: target,
            targetKind: 'rice_bridge',
            deviceId: device,
            grantId: grant,
            grantVersion: 1,
            scopeDigest: 'sha256:' + 'a'.repeat(64),
            workCopy: { id: randomUUID(), kind: 'in_place' },
          },
          action: 'local.fs.changeset',
          inputDigest: runtimePolicyDigest({ delete: 'synthetic-test.txt' }),
          dataScope: [],
          baseline: [],
          command: null,
        };
        await authorizeFixturePlatformAdministrator(f.db, f.ownerId);
        await setRuntimePolicyControls(
          f.context,
          {
            version: 1,
            enabled: true,
            mode: 'execute',
            rules: [{ action: binding.action, effect: 'ask' }],
          },
          null,
          f.db,
        );
        const [settings] =
          await f.db`select revision from allrice_member_work_automation where organization_id=${f.organizationId} and workspace_id=${f.workspaceId} and user_id=${f.ownerId}`;
        await updateWorkAutomation(
          f.context,
          f.workspaceId,
          {
            expectedRevision: settings!.revision,
            capability: 'computer',
            enabled: false,
          },
          f.db,
        );
        const options = {
          context: f.context,
          resolveCurrentBinding: async () => structuredClone(binding),
        };
        const admission = createRuntimePolicyAdmission(options);
        const admit = (phase: 'create' | 'dispatch') =>
          f.db.begin((transaction) =>
            admission({ transaction, binding, phase, now: new Date() }),
          );
        expect(await admit('create')).toEqual({ status: 'waiting_user' });
        await expect(admit('dispatch')).rejects.toMatchObject({
          code: 'approval_required',
        });
        await requestRuntimeActionApproval(options, binding, 600_000, f.db);
        await expect(admit('dispatch')).rejects.toMatchObject({
          code: 'approval_invalid_or_stale',
        });
        const [current] =
          await f.db`select revision from allrice_member_work_automation where organization_id=${f.organizationId} and workspace_id=${f.workspaceId} and user_id=${f.ownerId}`;
        await updateWorkAutomation(
          f.context,
          f.workspaceId,
          {
            expectedRevision: current!.revision,
            capability: 'computer',
            enabled: true,
          },
          f.db,
        );
        const automaticBinding = {
          ...binding,
          attempt: { ...binding.attempt, operationId: randomUUID() },
        };
        const automaticAdmission = createRuntimePolicyAdmission({
          context: f.context,
          resolveCurrentBinding: async () => structuredClone(automaticBinding),
        });
        const admitAutomatic = () =>
          f.db.begin((transaction) =>
            automaticAdmission({
              transaction,
              binding: automaticBinding,
              phase: 'create',
              now: new Date(),
            }),
          );
        // The existing computer setting can allow a fresh exact operation.
        // Saving a reminder is never an alternative to current target authority.
        expect(await admitAutomatic()).toBeUndefined();
        await f.db`update allrice_bridge_folder_grants set revoked_at=clock_timestamp() where id=${grant}`;
        await expect(admitAutomatic()).rejects.toMatchObject({
          code: 'grant_revoked_or_changed',
        });
      } finally {
        await failJob({
          workerId: r.workerId,
          jobId: r.job.id,
          leaseToken: r.job.lease!.token,
          code: 'FIXTURE_DONE',
          message: 'Due approval boundary verified',
          retryable: false,
        });
      }
    });
    it('rejects an actual dispatched native occurrence even with scheduling permission', async () => {
      const r = await runningOnce('请在 15 分钟后回复校验词。');
      const [binding] =
        await f.db`select user_message_id from allrice_employee_runs where run_id=${r.runId}`;
      const before = await counts();
      try {
        await expect(
          createOnceTaskFromExecutionContext({
            context: r.context,
            sessionId: r.sessionId,
            userMessageId: binding!.user_message_id,
            callId: randomUUID(),
            arguments: {
              name: '不能再预约',
              prompt: '再次执行',
              delayMinutes: 15,
            },
            worker: { attempt: r.job.attempt, leaseToken: r.job.lease!.token },
            name: '不能再预约',
            prompt: '再次执行',
            delayMinutes: 15,
          }),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
        expect(await counts()).toEqual(before);
      } finally {
        await failJob({
          workerId: r.workerId,
          jobId: r.job.id,
          leaseToken: r.job.lease!.token,
          code: 'FIXTURE_DONE',
          message: 'Internal source rejected',
          retryable: false,
        });
      }
    });
    it('rejects a legacy occurrence before its run_id link is filled', async () => {
      const a = await task(),
        occurrenceId = randomUUID(),
        legacyId = randomUUID();
      // Seed only the legacy source row; never downgrade a new native AR.
      await f.db`insert into allrice_automations
        (id,organization_id,workspace_id,owner_id,name,prompt,trigger_type,schedule,status,
         conversation_mode,employee_assignment_id,session_id,clock_owner)
        values(${legacyId},${f.organizationId},${f.workspaceId},${f.ownerId},'Legacy internal source',
          'Isolated legacy source only','schedule',${f.db.json({ frequency: 'daily', time: '08:30', timezone: 'Asia/Shanghai' })},
          'paused','reuse',${f.assignmentId},${a.sessionId},'legacy')`;
      await f.db`insert into allrice_automation_runs(id,organization_id,workspace_id,automation_id,status,scheduled_for)
        values(${occurrenceId},${f.organizationId},${f.workspaceId},${legacyId},'queued',clock_timestamp())`;
      const [legacySource] =
        await f.db`select ar.run_id,ar.conversation_snapshot,a.clock_owner
        from allrice_automation_runs ar join allrice_automations a on a.id=ar.automation_id where ar.id=${occurrenceId}`;
      expect(legacySource).toEqual({
        run_id: null,
        conversation_snapshot: null,
        clock_owner: 'legacy',
      });
      const r = await leasedChat('请在 15 分钟后回复校验词。', occurrenceId);
      try {
        const [legacy] =
          await f.db`select run_id from allrice_automation_runs where id=${occurrenceId}`;
        expect(legacy!.run_id).toBeNull();
        const before = await counts();
        await expect(
          createOnceTaskFromExecutionContext(r.input),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
        expect(await counts()).toEqual(before);
      } finally {
        await r.finish();
        await cancelOnceTask(f.context, a.sessionId, a.task.id);
      }
    });
    it('preserves a maximum-length form task on dispatch without truncating or exceeding the message limit', async () => {
      await f.db`update allrice_jobs set status='canceled' where status='queued'`;
      const prompt = '字'.repeat(40_000);
      const a = await task(undefined, prompt);
      await receipt(a.task.id);
      expect(await dispatchNextNativeOnceOccurrence(randomUUID())).toBe(true);
      const rows =
        await f.db`select m.content->>'text' text from allrice_automation_runs ar
        join allrice_employee_runs er on er.run_id=ar.run_id
        join allrice_messages m on m.id=er.user_message_id where ar.automation_id=${a.task.id}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.text).toBe(prompt);
    });
    it('freezes the current version at dispatch and keeps the original binding on later readback', async () => {
      const a = await task();
      const v3 = await publishVersion(3, ['automation.create']);
      await receipt(a.task.id);
      await dispatchNextNativeOnceOccurrence(randomUUID());
      const first = (
        await listOnceTasks(f.context, a.sessionId, {
          clientRequestId: a.input.clientRequestId,
        })
      ).tasks[0]!;
      const [bound] =
        await f.db`select employee_version_id,execution_snapshot from allrice_employee_runs where run_id=${first.runId}`;
      expect(bound!.employee_version_id).toBe(v3);
      await publishVersion(4, ['workspace.export.create']);
      expect(
        (await createOnceTask(f.context, a.sessionId, a.input)).runId,
      ).toBe(first.runId);
      const [same] =
        await f.db`select employee_version_id,execution_snapshot from allrice_employee_runs where run_id=${first.runId}`;
      expect(same).toEqual(bound);
    });
  },
);
