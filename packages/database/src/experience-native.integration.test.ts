import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createP27CodexWorkerFixture } from '../../../scripts/acceptance/runtime/p27-codex-worker-fixture.ts';
import { authorizeFixturePlatformAdministrator } from './platform-authority.fixture.ts';
import { createNativeRecurringSqlStore } from './native-schedule-recurring-sql.ts';
import {
  lockNativeRecurringAdmissions,
  dispatchNextNativeRecurringOccurrence,
} from './native-schedule-recurring-product.ts';
import {
  lockExperienceCalendarAdmissions,
  materializeExperienceNativeCalendar,
} from './experience-native.ts';
import {
  readExperiencePolicy,
  updateExperiencePolicy,
} from './experience-consolidation.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';
import { nextScheduleAt } from './execution/automation.ts';
import {
  nativeOnceDigest,
  type NativeOnceTask,
  type NativeOnceWriter,
} from './native-schedule-once-state.ts';
import type {
  NativeCalendarArm,
  NativeCalendarControl,
  NativeCalendarPeriod,
  NativeCalendarWrite,
} from './native-schedule-calendar-state.ts';
import * as client from './core/client.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'experience calendar original-business cycle; isolated SQL records, not a native Host',
  { timeout: 30_000 },
  () => {
    let f: Awaited<ReturnType<typeof createP27CodexWorkerFixture>>;
    let store: ReturnType<typeof createNativeRecurringSqlStore>,
      writer: NativeOnceWriter;
    let c: NativeCalendarControl,
      p: NativeCalendarPeriod,
      a: NativeCalendarArm,
      initialP: string,
      automationId: string;
    let native: NativeOnceTask, receiptWrite: NativeCalendarWrite;
    const reference = {
      artifactId: `sha256:${'a'.repeat(64)}`,
      profileId: 'allrice-recurring-control-v1',
      storageId: 'isolated-experience',
      stateRoot: '/isolated/experience',
    };
    const ready = {
      enabled: true,
      storageReady: true,
      legacyClockExcluded: true,
      controlArtifactApproved: true,
    };
    const calendar = () => store.calendar!;
    const version = async () => {
      const [r] =
        await f.db`select value from allrice_settings where scope_type='organization' and scope_id=${f.organizationId} and key='employee_experience_policy'`;
      return r!.value;
    };
    const policy = async (frequency: 'monthly' | 'off') => {
      const previous = await readExperiencePolicy(f.organizationId);
      return updateExperiencePolicy(f.context, f.organizationId, {
        frequency,
        timezone: 'America/New_York',
        time: '02:30',
        weekday: 1,
        monthDay: 31,
        expectedRevision: previous.revision,
        validationMode: 'off',
        adoptionMode: 'off',
      });
    };
    function write(
      mutation: NativeCalendarWrite['mutation'],
    ): NativeCalendarWrite {
      return {
        writeId: randomUUID(),
        digest: nativeOnceDigest(mutation),
        mutation,
      };
    }
    async function load(periodId?: string) {
      const s = await calendar().loadCalendarState(writer);
      c = s.controls[0]!.control;
      const b = periodId
        ? s.bindings.find((b) => b.period.periodId === periodId)
        : s.bindings.find((b) => !b.closed);
      expect(b).toBeTruthy();
      p = b!.period;
      a = b!.arm;
      return b!;
    }
    async function put(task: NativeOnceTask) {
      const w = write({
        kind: 'calendar',
        action: 'put_task',
        controlId: c.controlId,
        periodId: p.periodId,
        armId: a.armId,
        requestDigest: a.requestDigest,
        expectedPeriodVersion: p.version,
        expectedArmVersion: a.snapshotVersion,
        task,
      });
      expect(await store.commitMutation(writer, w)).toBe('committed');
      const exact = await calendar().readExactCalendarArm(
        a.armId,
        a.requestDigest,
      );
      expect(exact.state).toBe('bound');
      if (exact.state !== 'bound') throw Error('missing SQL Task');
      p = exact.period;
      a = exact.arm;
      native = exact.fullTask;
      return w;
    }
    async function createSqlTask() {
      const started = await calendar().beginCalendarArmCreate(writer, {
        periodId: p.periodId,
        armId: a.armId,
        requestDigest: a.requestDigest,
        expectedPeriodVersion: p.version,
        expectedArmVersion: a.snapshotVersion,
      });
      p = started.period;
      a = started.arm;
      await put({
        sessionId: c.controlSessionId,
        status: 'active',
        record: {
          id: randomUUID(),
          kind: 'at',
          scheduledAt: a.nativeAt,
          title: 'AllRice once control',
          prompt:
            'Synthetic schedule control only. Never execute business work.',
        },
      });
    }
    async function receipt() {
      const task = structuredClone(native);
      task.status = 'inactive';
      task.lastDelivery = {
        scheduledAt: a.nativeAt,
        deliveredAt: new Date(Date.parse(a.nativeAt) + 1_000).toISOString(),
        messageId: randomUUID(),
      };
      task.deliveryHistory = {
        records: [{ ...task.lastDelivery, prompt: task.record.prompt }],
        earlierRecordsUnavailable: false,
      };
      return put(task);
    }
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_EXPERIENCE_REVIEW_ENABLED', '1');
      vi.stubEnv('ALLRICE_NATIVE_RECURRING_ENABLED', '1');
      vi.stubEnv('ALLRICE_NATIVE_CALENDAR_ENABLED', '1');
      vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '0');
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
      f = await createP27CodexWorkerFixture({
        allowCiDatabase: true,
        personalProfile: 'writable',
      });
      vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
      await authorizeFixturePlatformAdministrator(f.db, f.ownerId);
      await policy('monthly');
      const [instance] =
        await f.db`select id from allrice_employee_instances where assignment_id=${f.assignmentId} and owner_id=${f.ownerId} and archived_at is null`;
      automationId = randomUUID();
      initialP = new Date(Date.now() - 40 * 86_400_000).toISOString();
      const current = await version();
      await f.db`insert into allrice_automations(id,organization_id,workspace_id,owner_id,name,prompt,trigger_type,schedule,status,
      conversation_mode,employee_assignment_id,next_run_at,experience_binding)
      values(${automationId},${f.organizationId},${f.workspaceId},${f.ownerId},'Isolated calendar','No model','schedule',
        ${f.db.json({ frequency: 'monthly', timezone: 'America/New_York', time: '02:30', weekday: 1, monthDay: 31 })},'paused','new_each_run',
        ${f.assignmentId},${initialP}::timestamptz,${f.db.json({ schemaVersion: 1, instanceId: instance!.id, policyDigest: runtimePolicyDigest(current) })})`;
      await f.db`insert into allrice_native_once_partitions(partition_id,reference,activation)
      values('allrice-recurring-v1',${f.db.json(reference)},${f.db.json(ready)})`;
      store = createNativeRecurringSqlStore({
        db: f.db,
        partitionId: 'allrice-recurring-v1',
        ownerId: 'isolated-experience-writer',
        reference,
        readiness: () => ready,
        decodeTask: (v) => structuredClone(v) as NativeOnceTask,
        lockAdmission: lockNativeRecurringAdmissions,
        calendar: {
          enabled: true,
          lockAdmission: lockExperienceCalendarAdmissions,
        },
        proveClosed: async (w) => ({
          kind: 'verified_process_exit',
          proofId: randomUUID(),
          partitionId: w.partitionId,
          ownerId: w.ownerId,
          epoch: w.epoch,
          tokenDigest: nativeOnceDigest(w.token),
          evidence: { fixture: 'SQL only; no Host' },
        }),
      });
      writer = (await store.acquireWriter())!.writer;
    });
    afterAll(async () => {
      await f?.close();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });
    it('never enables or migrates a paused legacy experience merely because the producer is enabled', async () => {
      expect(
        await materializeExperienceNativeCalendar(
          calendar(),
          writer,
          reference,
        ),
      ).toBe(false);
      const [r] =
        await f.db`select clock_owner,status,next_run_at from allrice_automations where id=${automationId}`;
      expect(r).toMatchObject({ clock_owner: 'legacy', status: 'paused' });
      expect(r!.next_run_at.toISOString()).toBe(initialP);
      expect(
        await f.db`select * from allrice_native_calendar_plans`,
      ).toHaveLength(0);
    });
    it('hands off the exact overdue P only after explicit fixture activation; all birth writes commit together', async () => {
      // Deliberate test setup, not an automatic activation path in production.
      await f.db`update allrice_automations set status='enabled' where id=${automationId}`;
      expect(
        await materializeExperienceNativeCalendar(
          calendar(),
          writer,
          reference,
        ),
      ).toBe(true);
      await load();
      expect(p.businessScheduledFor).toBe(initialP);
      expect(a.nativeAt).toBe(initialP);
      const [r] =
        await f.db`select clock_owner,next_run_at from allrice_automations where id=${automationId}`;
      expect(r!.clock_owner).toBe('native_recurring');
      expect(r!.next_run_at.toISOString()).toBe(initialP);
      for (const [action, version] of [
        ['session_initializing', 0],
        ['session_ready', 1],
      ] as const)
        expect(
          await store.commitMutation(
            writer,
            write({
              kind: 'calendar',
              action,
              controlId: c.controlId,
              expectedControlVersion: version,
            }),
          ),
        ).toBe('committed');
      await load();
      const absent = await calendar().confirmCalendarArmAbsent(writer, {
        periodId: p.periodId,
        armId: a.armId,
        requestDigest: a.requestDigest,
        expectedPeriodVersion: p.version,
        expectedArmVersion: a.snapshotVersion,
        taskRecords: {},
      });
      p = absent.period;
      a = absent.arm;
      const prepared = await calendar().prepareCalendarArm(writer, {
        periodId: p.periodId,
        previousArmId: a.armId,
        expectedPeriodVersion: p.version,
        expectedArmVersion: a.snapshotVersion,
        armId: randomUUID(),
        nativeAt: new Date(Date.now() + 60_000).toISOString(),
      });
      p = prepared.period;
      a = prepared.arm;
      await createSqlTask();
      receiptWrite = await receipt();
    });
    it('commits empty original experience Run, terminal decision and exact N once, preserving old native ACK', async () => {
      const oldPeriod = p.periodId,
        oldArm = a.armId,
        oldRequest = a.requestDigest;
      expect(await dispatchNextNativeRecurringOccurrence(randomUUID())).toBe(
        true,
      );
      const [decision] =
        await f.db`select * from allrice_native_calendar_decisions where period_id=${oldPeriod}`;
      expect(decision!.outcome).toBe('empty');
      const [run] =
        await f.db`select * from allrice_automation_runs where id=${decision!.automation_run_id}`;
      expect(run).toMatchObject({
        status: 'succeeded',
        run_id: null,
        error_code: 'EXPERIENCE_NO_NEW_EVIDENCE',
      });
      expect(run!.scheduled_for.toISOString()).toBe(initialP);
      expect(run!.experience_occurrence.sources).toEqual([]);
      const [next] =
        await f.db`select * from allrice_native_calendar_plans where period_id=${decision!.successor_period_id}`;
      const [v] =
        await f.db`select configuration from allrice_native_recurring_versions where automation_id=${automationId} and revision=1`;
      expect(next!.business_scheduled_for.toISOString()).toBe(
        nextScheduleAt(
          v!.configuration.schedule,
          decision!.decided_at,
        ).toISOString(),
      );
      expect(await store.readExactCommit(writer, receiptWrite)).toBe(
        'committed',
      );
      expect(
        (await calendar().readExactCalendarArm(oldArm, oldRequest)).state,
      ).toBe('bound');
      expect(
        await f.db`select id from allrice_jobs where payload->>'type'='allrice.experience.consolidate'`,
      ).toHaveLength(0);
      expect(
        await materializeExperienceNativeCalendar(
          calendar(),
          writer,
          reference,
          false,
        ),
      ).toBe(true);
      await load(next!.period_id);
      await createSqlTask();
    });
    it('policy off/resume keeps the same future P in distinct immutable periods and uses no Web writer', async () => {
      const oldPeriod = p.periodId,
        oldTask = structuredClone(native),
        oldArm = a.armId,
        oldRequest = a.requestDigest,
        futureP = p.businessScheduledFor;
      await policy('off');
      await policy('monthly');
      const [canceled] =
        await f.db`select outcome from allrice_native_calendar_decisions where period_id=${oldPeriod}`;
      expect(canceled!.outcome).toBe('canceled');
      const [next] =
        await f.db`select * from allrice_native_calendar_plans where automation_id=${automationId} and closed_decision_id is null`;
      expect(next!.period_id).not.toBe(oldPeriod);
      expect(next!.business_scheduled_for.toISOString()).toBe(futureP);
      expect(
        await materializeExperienceNativeCalendar(
          calendar(),
          writer,
          reference,
          false,
        ),
      ).toBe(true);
      await load(oldPeriod);
      native = oldTask;
      await receipt();
      const [oldReceipt] =
        await f.db`select occurrence_id,outbox_state from allrice_native_recurring_occurrences where calendar_period_id=${oldPeriod}`;
      expect(oldReceipt!.outbox_state).toBe('blocked');
      await load(next!.period_id);
      await createSqlTask();
      await receipt();
      const [newReceipt] =
        await f.db`select occurrence_id,outbox_state from allrice_native_recurring_occurrences where calendar_period_id=${next!.period_id}`;
      expect(newReceipt!.occurrence_id).not.toBe(oldReceipt!.occurrence_id);
      expect(newReceipt!.outbox_state).toBe('pending');
      expect(
        (await calendar().readExactCalendarArm(oldArm, oldRequest)).state,
      ).toBe('bound');
      expect(await store.readExactCommit(writer, receiptWrite)).toBe(
        'committed',
      );
    });
  },
);
