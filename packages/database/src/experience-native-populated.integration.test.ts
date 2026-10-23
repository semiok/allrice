import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createP27CodexWorkerFixture } from '../../../scripts/acceptance/runtime/p27-codex-worker-fixture.ts';
import { authorizeFixturePlatformAdministrator } from './platform-authority.fixture.ts';
import { seedExperienceCalendarRule } from './experience-native.fixture.ts';
import { loadPlatformContentCatalog } from './platform-content/catalog.ts';
import { synchronizePlatformContent } from './platform-content/sync.ts';
import { freezeEmployeeBaseSkills } from './employees/employee-base-skills.ts';
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
  dispatchExperienceOccurrence,
  recoverExperienceOccurrences,
  getExperienceExecution,
  readExperiencePolicy,
  reserveExperienceOccurrenceInTransaction,
  updateExperiencePolicy,
  type ExperienceScheduleRule,
} from './experience-consolidation.ts';
import { claimNextJob, startClaimedJob } from './execution/queue.ts';
import { claimDueAutomations, nextScheduleAt } from './execution/automation.ts';
import { lockNativeOnceJobAdmission } from './native-schedule-once-authority.ts';
import {
  nativeOnceDigest,
  type NativeOnceTask,
  type NativeOnceWriter,
} from './native-schedule-once-state.ts';
import type { NativeCalendarWrite } from './native-schedule-calendar-state.ts';
import * as client from './core/client.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'native experience nonempty sources and original queue; SQL only, no Host/provider',
  { timeout: 30_000 },
  () => {
    let f: Awaited<ReturnType<typeof createP27CodexWorkerFixture>>;
    let store: ReturnType<typeof createNativeRecurringSqlStore>,
      writer: NativeOnceWriter;
    const reference = {
      artifactId: `sha256:${'a'.repeat(64)}`,
      profileId: 'allrice-recurring-control-v1',
      storageId: 'isolated-populated',
      stateRoot: '/isolated/populated',
    };
    const ready = {
      enabled: true,
      storageReady: true,
      legacyClockExcluded: true,
      controlArtifactApproved: true,
    };
    const write = (
      mutation: NativeCalendarWrite['mutation'],
    ): NativeCalendarWrite => ({
      writeId: randomUUID(),
      digest: nativeOnceDigest(mutation),
      mutation,
    });
    beforeEach(async () => {
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
      // Match the original experience suite's actual published Skill setup.
      await synchronizePlatformContent(await loadPlatformContentCatalog());
      const published = await freezeEmployeeBaseSkills([]);
      expect(published.catalog).toBeTruthy();
      expect(
        published.nativeSkills.some(
          (s) => s.name === 'experience-consolidation',
        ),
      ).toBe(true);
      await authorizeFixturePlatformAdministrator(f.db, f.ownerId);
      const previous = await readExperiencePolicy(f.organizationId);
      await updateExperiencePolicy(f.context, f.organizationId, {
        frequency: 'monthly',
        timezone: 'America/New_York',
        time: '02:30',
        weekday: 1,
        monthDay: 31,
        expectedRevision: previous.revision,
        validationMode: 'off',
        adoptionMode: 'off',
      });
      await f.db`insert into allrice_native_once_partitions(partition_id,reference,activation)
      values('allrice-recurring-v1',${f.db.json(reference)},${f.db.json(ready)})`;
      store = createNativeRecurringSqlStore({
        db: f.db,
        partitionId: 'allrice-recurring-v1',
        ownerId: randomUUID(),
        reference,
        ttlMs: 300_000,
        readiness: () => ready,
        decodeTask: (v) => structuredClone(v) as NativeOnceTask,
        lockAdmission: lockNativeRecurringAdmissions,
        calendar: {
          enabled: true,
          lockAdmission: lockExperienceCalendarAdmissions,
        },
        proveClosed: async () => null,
      });
      writer = (await store.acquireWriter())!.writer;
    }, 120_000);
    afterEach(async () => {
      try {
        await f?.close();
      } finally {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
      }
    }, 30_000);
    async function sqlReceipt(automationId: string) {
      const calendar = store.calendar!;
      expect(
        await materializeExperienceNativeCalendar(calendar, writer, reference),
      ).toBe(true);
      let state = await calendar.loadCalendarState(writer);
      const c = state.controls.find(
        (r) => r.control.automationId === automationId,
      )!.control;
      let b = state.bindings.find(
        (r) => r.period.automationId === automationId && !r.closed,
      )!;
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
      // Use the REAL combined store document, including its null prototype.
      expect(
        Object.getPrototypeOf(await store.loadTaskRecords(writer)),
      ).toBeNull();
      const absent = await calendar.confirmCalendarArmAbsent(writer, {
        periodId: b.period.periodId,
        armId: b.arm.armId,
        requestDigest: b.arm.requestDigest,
        expectedPeriodVersion: b.period.version,
        expectedArmVersion: b.arm.snapshotVersion,
        taskRecords: await store.loadTaskRecords(writer),
      });
      const prepared = await calendar.prepareCalendarArm(writer, {
        periodId: absent.period.periodId,
        previousArmId: absent.arm.armId,
        expectedPeriodVersion: absent.period.version,
        expectedArmVersion: absent.arm.snapshotVersion,
        armId: randomUUID(),
        nativeAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const started = await calendar.beginCalendarArmCreate(writer, {
        periodId: prepared.period.periodId,
        armId: prepared.arm.armId,
        requestDigest: prepared.arm.requestDigest,
        expectedPeriodVersion: prepared.period.version,
        expectedArmVersion: prepared.arm.snapshotVersion,
      });
      b = { ...b, ...started };
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
        const exact = await calendar.readExactCalendarArm(
          b.arm.armId,
          b.arm.requestDigest,
        );
        if (exact.state !== 'bound')
          throw Error('calendar_fixture_task_not_bound');
        b = { ...b, period: exact.period, arm: exact.arm };
        return w;
      }
      await put();
      const delivery = {
        scheduledAt: b.arm.nativeAt,
        deliveredAt: new Date(Date.parse(b.arm.nativeAt) + 1_000).toISOString(),
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
      const receiptWrite = await put();
      state = await calendar.loadCalendarState(writer);
      return { period: b.period, arm: b.arm, receiptWrite, state };
    }
    it.each(['queued', 'budget'] as const)(
      '%s keeps original incremental pins, queue/instance quota and one successor N',
      async (mode) => {
        const seeded = await seedExperienceCalendarRule(f, mode);
        if (seeded.legacyOccurrenceId)
          await dispatchExperienceOccurrence(seeded.legacyOccurrenceId);
        const beforeRuns =
          await f.db`select id from allrice_automation_runs where automation_id=${seeded.automationId}`;
        const native = await sqlReceipt(seeded.automationId);
        expect(native.period.businessScheduledFor).toBe(seeded.P.toISOString());
        expect(await dispatchNextNativeRecurringOccurrence(randomUUID())).toBe(
          true,
        );
        const [d] =
          await f.db`select * from allrice_native_calendar_decisions where period_id=${native.period.periodId}`;
        expect(d!.outcome).toBe(mode);
        const [successor] =
          await f.db`select * from allrice_native_calendar_plans where period_id=${d!.successor_period_id}`;
        const [v] =
          await f.db`select configuration from allrice_native_recurring_versions where automation_id=${seeded.automationId} and revision=1`;
        expect(successor!.business_scheduled_for.toISOString()).toBe(
          nextScheduleAt(
            v!.configuration.schedule,
            d!.decided_at,
          ).toISOString(),
        );
        expect(await store.readExactCommit(writer, native.receiptWrite)).toBe(
          'committed',
        );
        const [source] =
          await f.db`select consolidation_occurrence_id from allrice_experience_reviews where memory_id=${seeded.source!.id}`;
        if (mode === 'budget') {
          expect(d!.automation_run_id).toBeNull();
          expect(d!.decision.budget).toEqual({
            globalCount: 1,
            organizationCount: 1,
            instanceCount: 1,
          });
          expect(source!.consolidation_occurrence_id).toBeNull();
          expect(
            await f.db`select id from allrice_automation_runs where automation_id=${seeded.automationId}`,
          ).toHaveLength(beforeRuns.length);
          expect(
            await f.db`select id from allrice_jobs where payload->>'type'='allrice.experience.consolidate'`,
          ).toHaveLength(1);
        } else {
          expect(source!.consolidation_occurrence_id).toBe(
            d!.automation_run_id,
          );
          const [pending] =
            await f.db`select run_id,status from allrice_automation_runs where id=${d!.automation_run_id}`;
          expect(pending).toMatchObject({ run_id: null, status: 'queued' });
          // Recovery consumes a committed native AR, never the legacy due clock.
          expect(await claimDueAutomations(1)).toBe(0);
          const [stillPending] =
            await f.db`select run_id,status from allrice_automation_runs where id=${d!.automation_run_id}`;
          expect(stillPending).toEqual(pending);
          expect(await recoverExperienceOccurrences(1)).toContain(
            d!.automation_run_id,
          );
          await dispatchExperienceOccurrence(d!.automation_run_id);
          expect(await recoverExperienceOccurrences(1)).not.toContain(
            d!.automation_run_id,
          );
          await dispatchExperienceOccurrence(d!.automation_run_id);
          const [run] =
            await f.db`select * from allrice_automation_runs where id=${d!.automation_run_id}`;
          expect(
            run!.experience_occurrence.sources.map((s: { id: string }) => s.id),
          ).toEqual([seeded.source!.id]);
          expect(run!.run_id).toBeTruthy();
          const jobs =
            await f.db`select * from allrice_jobs where run_id=${run!.run_id}`;
          expect(jobs).toHaveLength(1);
          const job = jobs[0]!;
          expect(
            await f.db.begin((tx) => lockNativeOnceJobAdmission(tx, job.id)),
          ).toEqual({ scheduled: true, allowed: true, runId: run!.run_id });
          const workerId = randomUUID(),
            claimed = await claimNextJob(workerId, 120_000, {
              allowBackground: true,
            });
          expect(claimed!.id).toBe(job.id);
          expect(
            await startClaimedJob(workerId, claimed!.id, claimed!.lease!.token),
          ).not.toBeNull();
          expect(
            (await getExperienceExecution(run!.run_id)).occurrence.id,
          ).toBe(d!.automation_run_id);
          const exact = await f.db.begin(async (tx) => {
            const [rule] = await tx<
              ExperienceScheduleRule[]
            >`select * from allrice_automations where id=${seeded.automationId} for update`;
            return reserveExperienceOccurrenceInTransaction(
              tx,
              rule!,
              seeded.P,
              null,
            );
          });
          expect(exact).toEqual({
            outcome: 'already_claimed',
            automationRunId: d!.automation_run_id,
          });
          const rollback = Error('fixture permission rollback');
          await expect(
            f.db.begin(async (tx) => {
              await tx`update allrice_memberships set role='viewer' where user_id=${f.ownerId} and organization_id=${f.organizationId}`;
              expect(await lockNativeOnceJobAdmission(tx, job.id)).toEqual({
                scheduled: true,
                allowed: false,
                runId: run!.run_id,
              });
              throw rollback;
            }),
          ).rejects.toBe(rollback);
        }
        expect(await dispatchNextNativeRecurringOccurrence(randomUUID())).toBe(
          false,
        );
        expect(
          await f.db`select period_id from allrice_native_calendar_plans where automation_id=${seeded.automationId} and closed_decision_id is null`,
        ).toHaveLength(1);
        expect(
          await materializeExperienceNativeCalendar(
            store.calendar!,
            writer,
            reference,
            false,
          ),
        ).toBe(true);
        const next = (
          await store.calendar!.loadCalendarState(writer)
        ).bindings.find((b) => b.period.periodId === successor!.period_id)!;
        expect(next.period.businessScheduledFor).toBe(
          successor!.business_scheduled_for.toISOString(),
        );
      },
    );
  },
);
