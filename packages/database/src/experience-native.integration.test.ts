import { randomUUID } from 'node:crypto';
import { experiencePolicySchedule } from '@allrice/contracts';
import { readFile } from 'node:fs/promises';
import { experiencePolicySchedule } from '@allrice/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createP27CodexWorkerFixture } from '../../../scripts/acceptance/runtime/p27-codex-worker-fixture.ts';
import { authorizeFixturePlatformAdministrator } from './platform-authority.fixture.ts';
import {
  seedExperienceCalendarRule,
  seedHistoricalExperienceCalendar,
} from './experience-native.fixture.ts';
import {
  experienceNativeCalendarEnabled,
  lockExperienceCalendarAdmissions,
  materializeExperienceNativeCalendar,
} from './experience-native.ts';
import {
  readExperiencePolicy,
  updateExperiencePolicy,
  reserveExperienceOccurrenceInTransaction,
  syncExperienceConsolidationSchedules,
} from './experience-consolidation.ts';
import { dispatchNextNativeRecurringOccurrence } from './native-schedule-recurring-product.ts';
import { createNativeRecurringSqlStore } from './native-schedule-recurring-sql.ts';
import {
  nativeOnceDigest,
  type NativeOnceTask,
} from './native-schedule-once-state.ts';
import * as client from './core/client.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'M5-A retired experience calendar; real isolated SQL, no Host/model',
  () => {
    let f: Awaited<ReturnType<typeof createP27CodexWorkerFixture>>;
    const reference = {
      artifactId: 'sha256:' + 'a'.repeat(64),
      profileId: 'allrice-recurring-control-v1',
      storageId: 'historical-experience',
      stateRoot: '/isolated/experience',
    };
    beforeEach(async () => {
      vi.stubEnv('ALLRICE_EXPERIENCE_REVIEW_ENABLED', '1');
      vi.stubEnv('ALLRICE_NATIVE_RECURRING_ENABLED', '1');
      vi.stubEnv('ALLRICE_NATIVE_CALENDAR_ENABLED', '1');
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
      f = await createP27CodexWorkerFixture({
        allowCiDatabase: true,
        personalProfile: 'writable',
      });
      vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(
        Error('No network/model in retirement regression'),
      );
      await authorizeFixturePlatformAdministrator(f.db, f.ownerId);
    }, 120000);
    afterEach(async () => {
      try {
        await f?.close();
      } finally {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
      }
    }, 30000);
    it('policy-off prevents reservations with all runtime flags on', async () => {
      const seeded = await seedExperienceCalendarRule(f, 'queued');
      const policy = await readExperiencePolicy(f.organizationId);
      await updateExperiencePolicy(f.context, f.organizationId, {
        ...experiencePolicySchedule(policy),
        frequency: 'off',
        expectedRevision: policy.revision,
      });
      const [rule] =
        await f.db`select * from allrice_automations where id=${seeded.automationId}`;
      const before =
        await f.db`select to_jsonb(a) data from allrice_automations a`;
      expect((await readExperiencePolicy(f.organizationId)).frequency).toBe(
        'off',
      );
      expect(experienceNativeCalendarEnabled()).toBe(true);
      expect(await syncExperienceConsolidationSchedules()).toBe(0);
      await expect(
        f.db.begin((tx) =>
          reserveExperienceOccurrenceInTransaction(tx, rule as never, seeded.P),
        ),
      ).resolves.toEqual({
        outcome: 'policy_blocked',
        reason: 'policy_changed',
      });
      expect(
        await f.db`select to_jsonb(a) data from allrice_automations a`,
      ).toEqual(before);
      expect(await f.db`select id from allrice_automation_runs`).toHaveLength(
        0,
      );
      expect(await f.db`select id from allrice_jobs`).toHaveLength(0);
      const ready = {
        enabled: true,
        storageReady: true,
        legacyClockExcluded: true,
        controlArtifactApproved: true,
      };
      await f.db`insert into allrice_native_once_partitions(partition_id,reference,activation) values('allrice-recurring-v1',${f.db.json(reference)},${f.db.json(ready)})`;
      const store = createNativeRecurringSqlStore({
        db: f.db,
        partitionId: 'allrice-recurring-v1',
        ownerId: randomUUID(),
        reference,
        readiness: () => ready,
        decodeTask: (v) => structuredClone(v) as NativeOnceTask,
        lockAdmission: async () => new Map(),
        calendar: {
          enabled: true,
          lockAdmission: lockExperienceCalendarAdmissions,
        },
        proveClosed: async () => null,
      });
      const writer = (await store.acquireWriter())!.writer;
      expect(
        await materializeExperienceNativeCalendar(
          store.calendar!,
          writer,
          reference,
        ),
      ).toBe(false);
      expect(
        await f.db`select * from allrice_native_calendar_plans`,
      ).toHaveLength(0);
      expect(
        await f.db`select to_jsonb(a) data from allrice_automations a`,
      ).toEqual(before);
    });
    it.each(['empty', 'queued'] as const)(
      'retains an old %s receipt without claiming, replaying or creating a successor',
      async (mode) => {
        const seeded = await seedExperienceCalendarRule(f, mode);
        const old = await seedHistoricalExperienceCalendar(
          f,
          seeded.automationId,
          reference,
        );
        const policy = await readExperiencePolicy(f.organizationId);
        await updateExperiencePolicy(f.context, f.organizationId, {
          ...experiencePolicySchedule(policy),
          frequency: 'off',
          expectedRevision: policy.revision,
        });
        const state = async () => ({
          receipts:
            await f.db`select to_jsonb(o) data from allrice_native_recurring_occurrences o`,
          plans:
            await f.db`select to_jsonb(p) data from allrice_native_calendar_plans p`,
          rules: await f.db`select to_jsonb(a) data from allrice_automations a`,
        });
        const before = await state();
        for (let i = 0; i < 2; i++)
          expect(
            await dispatchNextNativeRecurringOccurrence(randomUUID()),
          ).toBe(false);
        expect(
          await materializeExperienceNativeCalendar(
            old.store.calendar!,
            old.writer,
            reference,
          ),
        ).toBe(false);
        expect(await state()).toEqual(before);
        expect(
          await old.store.readExactCommit(old.writer, old.receiptWrite!),
        ).toBe('committed');
        const facts = await f.db.begin((tx) =>
          lockExperienceCalendarAdmissions(tx, [old.control]),
        );
        expect(facts.get(old.control.controlId)).toMatchObject({
          allowed: false,
          status: 'paused',
        });
        const initializing = await f.db.begin((tx) =>
          lockExperienceCalendarAdmissions(tx, [old.control], 'initialize'),
        );
        expect(initializing.get(old.control.controlId)?.allowed).toBe(false);
        expect(await state()).toEqual(before);
        expect(
          await f.db`select * from allrice_native_calendar_decisions`,
        ).toHaveLength(1);
        expect(await f.db`select id from allrice_automation_runs`).toHaveLength(
          0,
        );
        expect(await f.db`select id from allrice_jobs`).toHaveLength(0);
      },
    );
    it('preserves the SQL fence against fabricated authority cancellation', async () => {
      const seeded = await seedExperienceCalendarRule(f, 'empty');
      const old = await seedHistoricalExperienceCalendar(
        f,
        seeded.automationId,
        reference,
      );
      await expect(
        f.db.begin(async (tx) => {
          await tx`update allrice_automations set status='paused',next_run_at=null where id=${seeded.automationId}`;
          const d = {
            decisionId: randomUUID(),
            periodId: old.period.periodId,
            kind: 'authority',
            outcome: 'authority_blocked',
            revision: old.period.revision,
            decidedAt: new Date().toISOString(),
            receiptOccurrenceId: null,
            automationRunId: null,
            successorPeriodId: null,
            lease: null,
            budget: null,
          };
          await tx`insert into allrice_native_calendar_decisions(decision_id,period_id,kind,outcome,revision,decision,decision_digest,decided_at)
        values(${d.decisionId},${d.periodId},${d.kind},${d.outcome},${d.revision},${tx.json(d)},${nativeOnceDigest(d)},${d.decidedAt}::timestamptz)`;
        }),
      ).rejects.toMatchObject({ code: '23514' });
      expect(
        await f.db`select * from allrice_native_calendar_decisions`,
      ).toHaveLength(0);
      expect(
        (
          await f.db`select status from allrice_automations where id=${seeded.automationId}`
        )[0]!.status,
      ).toBe('enabled');
    });
    it.each(['prepared', 'absent'] as const)(
      'requires real policy-off before the watermark and removes a retained %s arm from recovery',
      async (phase) => {
        const seeded = await seedExperienceCalendarRule(f, 'empty');
        const old = await seedHistoricalExperienceCalendar(
          f,
          seeded.automationId,
          reference,
          phase,
        );
        const migration = await readFile(
          new URL(
            '../migrations/0234_memory_source_cutover.sql',
            import.meta.url,
          ),
          'utf8',
        );
        const before = await readExperiencePolicy(f.organizationId);
        await expect(f.db.unsafe(migration)).rejects.toMatchObject({
          message: 'memory_source_cutover_requires_experience_policy_off',
        });
        expect(await readExperiencePolicy(f.organizationId)).toEqual(before);
        const paused = await updateExperiencePolicy(
          f.context,
          f.organizationId,
          {
            ...experiencePolicySchedule(before),
            expectedRevision: before.revision,
            frequency: 'off',
          },
        );
        expect(paused.frequency).toBe('off');
        const [decision] =
          await f.db`select kind,outcome from allrice_native_calendar_decisions where period_id=${old.period.periodId}`;
        expect(decision).toEqual({ kind: 'policy', outcome: 'canceled' });
        await f.db.unsafe(migration);
        const [open] =
          await f.db`select count(*)::int total from allrice_native_calendar_plans where control_id=${old.control.controlId} and closed_decision_id is null`;
        expect(open!.total).toBe(0);
        const snapshot = await old.store.calendar!.loadCalendarState(
          old.writer,
        );
        expect(snapshot.bindings).toEqual([]);
        expect(await dispatchNextNativeRecurringOccurrence(randomUUID())).toBe(
          false,
        );
        expect(await f.db`select id from allrice_jobs`).toHaveLength(0);
      },
    );
    it('M5-C cutover watermark alone cannot authorize cancellation of a retained native plan', async () => {
      const seeded = await seedExperienceCalendarRule(f, 'empty');
      const old = await seedHistoricalExperienceCalendar(
        f,
        seeded.automationId,
        reference,
      );
      // Exact B cutover effect: settings advance, original business/native revisions do not.
      await f.db`update allrice_settings set value=jsonb_set(jsonb_set(value,
        '{revision}',to_jsonb((value->>'revision')::int+1)),
        '{collectionStartedAt}',to_jsonb(to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')))
        where key='employee_experience_policy' and
          ((scope_type='organization' and scope_id=${f.organizationId}) or (scope_type='system' and scope_id is null))`;
      const facts = await f.db.begin((tx) =>
        lockExperienceCalendarAdmissions(tx, [old.control]),
      );
      expect(facts.get(old.control.controlId)).toMatchObject({
        allowed: false,
        status: 'enabled',
      });
      await expect(
        f.db.begin(async (tx) => {
          await tx`update allrice_automations set status='paused',next_run_at=null where id=${seeded.automationId}`;
          const d = {
            decisionId: randomUUID(),
            periodId: old.period.periodId,
            kind: 'authority',
            outcome: 'authority_blocked',
            revision: old.period.revision,
            decidedAt: new Date().toISOString(),
            receiptOccurrenceId: null,
            automationRunId: null,
            successorPeriodId: null,
            lease: null,
            budget: null,
          };
          await tx`insert into allrice_native_calendar_decisions(decision_id,period_id,kind,outcome,revision,decision,decision_digest,decided_at)
        values(${d.decisionId},${d.periodId},${d.kind},${d.outcome},${d.revision},${tx.json(d)},${nativeOnceDigest(d)},${d.decidedAt}::timestamptz)`;
        }),
      ).rejects.toMatchObject({
        code: 'P1921',
        message: 'experience native clock lacks exact scoped plan/policy proof',
      });
      expect(
        await f.db`select * from allrice_native_calendar_decisions`,
      ).toHaveLength(0);
      expect(
        (
          await f.db`select status from allrice_automations where id=${seeded.automationId}`
        )[0]!.status,
      ).toBe('enabled');
      // A real policy transaction advances all three revisions atomically.
      // This is an isolated cancellation check, not authorization to stop Dev.
      const previous = await readExperiencePolicy(f.organizationId);
      await updateExperiencePolicy(f.context, f.organizationId, {
        frequency: 'off',
        timezone: 'UTC',
        time: '03:00',
        weekday: 1,
        monthDay: 1,
        expectedRevision: previous.revision,
      });
      expect(
        await f.db`select kind,outcome from allrice_native_calendar_decisions where period_id=${old.period.periodId}`,
      ).toEqual([
        expect.objectContaining({ kind: 'policy', outcome: 'canceled' }),
      ]);
      expect(
        (
          await f.db`select allrice_experience_calendar_clock_proved(${seeded.automationId}::uuid) proved`
        )[0]!.proved,
      ).toBe(true);
      expect(await f.db`select id from allrice_jobs`).toHaveLength(0);
    });
    it('policy edits prepare a new revision while preserving old receipt identity', async () => {
      const seeded = await seedExperienceCalendarRule(f, 'empty');
      const old = await seedHistoricalExperienceCalendar(
        f,
        seeded.automationId,
        reference,
      );
      const previous = await readExperiencePolicy(f.organizationId);
      const settings = {
        frequency: 'daily',
        timezone: 'UTC',
        time: '03:00',
        weekday: 1,
        monthDay: 1,
        expectedRevision: previous.revision,
      };
      const enabled = await updateExperiencePolicy(
        f.context,
        f.organizationId,
        settings,
      );
      expect(enabled.frequency).toBe('daily');
      await updateExperiencePolicy(f.context, f.organizationId, {
        ...settings,
        expectedRevision: enabled.revision,
        frequency: 'off',
      });
      expect(
        (
          await f.db`select status,next_run_at from allrice_automations where id=${seeded.automationId}`
        )[0],
      ).toMatchObject({ status: 'paused', next_run_at: null });
      expect(
        (
          await f.db`select kind,outcome from allrice_native_calendar_decisions where period_id=${old.period.periodId}`
        )[0],
      ).toEqual({ kind: 'policy', outcome: 'canceled' });
      expect(
        await old.store.readExactCommit(old.writer, old.receiptWrite!),
      ).toBe('committed');
      expect(
        await f.db`select * from allrice_native_calendar_plans where closed_decision_id is null`,
      ).toHaveLength(0);
      expect(await dispatchNextNativeRecurringOccurrence(randomUUID())).toBe(
        false,
      );
    });
  },
);
