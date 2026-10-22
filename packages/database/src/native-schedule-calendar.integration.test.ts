import { randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createP27CodexWorkerFixture } from '../../../scripts/acceptance/runtime/p27-codex-worker-fixture.ts';
import {
  createNativeCalendarSqlStore,
  type NativeCalendarSqlOptions,
} from './native-schedule-calendar-sql.ts';
import { createNativeRecurringSqlStore } from './native-schedule-recurring-sql.ts';
import {
  calendarControlIdentity,
  calendarWriterIdentity,
  type NativeCalendarArm,
  type NativeCalendarControl,
  type NativeCalendarPeriod,
  type NativeCalendarRevision,
  type NativeCalendarWrite,
} from './native-schedule-calendar-state.ts';
import {
  nativeOnceDigest,
  type NativeOnceTask,
  type NativeOnceWriter,
} from './native-schedule-once-state.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'dormant calendar protocol, isolated SQL only (no public Host or model)',
  { timeout: 30_000 },
  () => {
    let f: Awaited<ReturnType<typeof createP27CodexWorkerFixture>>;
    let store: ReturnType<typeof createNativeCalendarSqlStore>,
      options: NativeCalendarSqlOptions;
    let c: NativeCalendarControl,
      v: NativeCalendarRevision,
      writer: NativeOnceWriter;
    let p: NativeCalendarPeriod, a: NativeCalendarArm, native: NativeOnceTask;
    const ready = {
      enabled: true,
      storageReady: true,
      legacyClockExcluded: true,
      controlArtifactApproved: true,
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
    function put(t: NativeOnceTask) {
      return write({
        kind: 'calendar',
        action: 'put_task',
        controlId: c.controlId,
        periodId: p.periodId,
        armId: a.armId,
        requestDigest: a.requestDigest,
        expectedPeriodVersion: p.version,
        expectedArmVersion: a.snapshotVersion,
        task: t,
      });
    }
    const current = () => ({
      periodId: p.periodId,
      armId: a.armId,
      requestDigest: a.requestDigest,
      expectedPeriodVersion: p.version,
      expectedArmVersion: a.snapshotVersion,
    });
    const future = () => new Date(Date.now() + 300_000).toISOString();
    async function refresh() {
      const r = await store.readExactCalendarArm(a.armId, a.requestDigest);
      expect(r.state).toBe('bound');
      if (r.state !== 'bound') throw Error('expected exact bound arm');
      p = r.period;
      a = r.arm;
      native = r.fullTask;
      return r;
    }
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '0');
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
      f = await createP27CodexWorkerFixture({
        allowCiDatabase: true,
        personalProfile: 'writable',
      });
      const [instance] = await f.db<
        { id: string }[]
      >`select id from allrice_employee_instances
      where assignment_id=${f.assignmentId} and owner_id=${f.ownerId} and archived_at is null`;
      expect(instance).toBeDefined();
      const automationId = randomUUID(),
        policyDigest = nativeOnceDigest('isolated-calendar-policy');
      v = {
        kind: 'calendar',
        binding: 'rotating-at-v1',
        consumer: 'experience-consolidation-v1',
        revision: 1,
        schedule: {
          frequency: 'monthly',
          monthDay: 31,
          time: '10:00',
          timezone: 'Asia/Shanghai',
        },
        ruleRevision: 1,
        policyRevision: 1,
        policyDigest,
        reservationDigest: nativeOnceDigest('isolated-reservation'),
        acceptedAt: new Date().toISOString(),
      };
      await f.db`insert into allrice_automations(id,organization_id,workspace_id,owner_id,name,prompt,
      trigger_type,schedule,status,conversation_mode,employee_assignment_id,next_run_at,experience_binding)
      values(${automationId},${f.organizationId},${f.workspaceId},${f.ownerId},'SQL-only calendar','Never execute',
        'schedule',${f.db.json(v.schedule)},'enabled','new_each_run',${f.assignmentId},clock_timestamp()-interval '40 days',
        ${f.db.json({ schemaVersion: 1, instanceId: instance!.id, policyDigest })})`;
      const reference = {
        artifactId: `sha256:${'a'.repeat(64)}`,
        profileId: 'allrice-recurring-control-v1' as const,
        storageId: 'sql-only-calendar-no-host',
        stateRoot: `/isolated/sql-only-calendar/${randomUUID()}`,
      };
      c = {
        kind: 'calendar',
        binding: 'rotating-at-v1',
        partitionId: 'allrice-recurring-v1',
        controlId: randomUUID(),
        organizationId: f.organizationId,
        workspaceId: f.workspaceId,
        ownerId: f.ownerId,
        automationId,
        revision: 1,
        controlSessionId: `sql-calendar-${randomUUID()}`,
        reference,
        sessionState: 'reserved',
        nativeTaskId: null,
        dispatch: {
          consumer: 'experience-consolidation-v1',
          employeeAssignmentId: f.assignmentId,
          employeeInstanceId: instance!.id,
        },
      };
      await f.db`insert into allrice_native_once_partitions(partition_id,reference,activation)
      values(${c.partitionId},${f.db.json(reference)},${f.db.json(ready)})`;
      options = {
        db: f.db,
        partitionId: c.partitionId,
        ownerId: randomUUID(),
        reference,
        enabled: true,
        ttlMs: 300_000,
        readiness: () => ready,
        decodeTask: (x) => structuredClone(x) as NativeOnceTask,
        // Synthetic SQL admission only; this is not a production authorization API.
        async lockAdmission(tx, controls) {
          const result = new Map();
          for (const control of controls) {
            const [row] = await tx<
              {
                revision: number;
                status: 'enabled' | 'paused';
                deleted_at: unknown;
              }[]
            >`
            select revision,status,deleted_at from allrice_automations where id=${control.automationId}
            and organization_id=${control.organizationId} and workspace_id=${control.workspaceId}
            and owner_id=${control.ownerId} for update`;
            result.set(control.controlId, {
              allowed: !!row && row.deleted_at === null,
              currentRevision: Number(row?.revision),
              policyRevision: v.policyRevision,
              policyDigest: v.policyDigest,
              status: row?.status ?? 'deleted',
              resumeAfter: null,
            });
          }
          return result;
        },
        // Explicit synthetic close proof exercises SQL fencing without claiming
        // any real Host/process acceptance. No Host was constructed in this suite.
        proveClosed: async (w) => ({
          kind: 'verified_process_exit',
          proofId: randomUUID(),
          partitionId: w.partitionId,
          ownerId: w.ownerId,
          epoch: w.epoch,
          tokenDigest: nativeOnceDigest(w.token),
          evidence: { fixture: 'isolated SQL only; no public Host' },
        }),
      };
      store = createNativeCalendarSqlStore(options);
      const grant = await store.acquireWriter();
      expect(grant).not.toBeNull();
      writer = grant!.writer;
      const [business] = await f.db<
        { next_run_at: Date }[]
      >`select next_run_at from allrice_automations where id=${c.automationId}`;
      const preparation = {
        controlId: c.controlId,
        expectedRevision: 1,
        periodId: randomUUID(),
        armId: randomUUID(),
        businessScheduledFor: business!.next_run_at.toISOString(),
        nativeAt: future(),
        reason: 'future_recovery' as const,
      };
      // All reservation effects take part in this existing business TX. This
      // test does not concatenate independently committed store methods.
      await expect(
        f.db.begin(async (tx) => {
          await store.initializeControlInTransaction(tx, {
            control: c,
            revision: v,
          });
          await store.prepareCalendarPeriodInTransaction(
            tx,
            writer,
            preparation,
          );
          throw Error('abort composed calendar reservation');
        }),
      ).rejects.toThrow('abort composed calendar reservation');
      expect(
        await f.db`select control_id from allrice_native_recurring_controls where automation_id=${c.automationId}`,
      ).toHaveLength(0);
      expect(
        await f.db`select revision from allrice_native_recurring_versions where automation_id=${c.automationId}`,
      ).toHaveLength(0);
      expect(
        await f.db`select period_id from allrice_native_calendar_periods where automation_id=${c.automationId}`,
      ).toHaveLength(0);
      expect(
        await f.db`select arm_id from allrice_native_calendar_arms`,
      ).toHaveLength(0);
      const reserved = await f.db.begin(async (tx) => {
        await store.initializeControlInTransaction(tx, {
          control: c,
          revision: v,
        });
        return store.prepareCalendarPeriodInTransaction(
          tx,
          writer,
          preparation,
        );
      });
      p = reserved.period;
      a = reserved.arm;
      expect(
        await store.initializeControl({ control: c, revision: v }),
      ).toEqual({ control: c, task: null });
      expect(
        await store.initializeControl({ control: c, revision: v }),
      ).toEqual({ control: c, task: null });
      for (const [action, expectedControlVersion] of [
        ['session_initializing', 0],
        ['session_ready', 1],
      ] as const) {
        const w = write({
          kind: 'calendar',
          action,
          controlId: c.controlId,
          expectedControlVersion,
        });
        expect(await store.commitMutation(writer, w)).toBe('committed');
        expect(await store.readExactCommit(writer, w)).toBe('committed');
      }
      c = { ...c, sessionState: 'ready' };
    }, 120_000);
    afterAll(async () => {
      try {
        await f?.close();
      } finally {
        vi.unstubAllEnvs();
      }
    }, 30_000);

    it('keeps the original business clock and fixed loader unchanged', async () => {
      expect(await store.loadCalendarControls(writer)).toEqual([c]);
      const [business] =
        await f.db`select clock_owner,schedule,conversation_mode,next_run_at from allrice_automations where id=${c.automationId}`;
      expect(business).toMatchObject({
        clock_owner: 'legacy',
        schedule: v.schedule,
        conversation_mode: 'new_each_run',
      });
      expect(business!.next_run_at).not.toBeNull();
      const fixed = createNativeRecurringSqlStore({
        ...options,
        lockAdmission: async () => new Map(),
      });
      await expect(fixed.loadControls(writer)).rejects.toThrow();
      await expect(f.db`update allrice_automations set clock_owner='native_recurring',native_recurring_request_id=id,
      native_recurring_request_digest=${v.reservationDigest},native_recurring_revision=1 where id=${c.automationId}`).rejects.toMatchObject(
        {
          code: 'P1921',
          message:
            'experience native clock lacks exact scoped plan/policy proof',
        },
      );
      const [unchanged] =
        await f.db`select clock_owner from allrice_automations where id=${c.automationId}`;
      expect(unchanged!.clock_owner).toBe('legacy');
    });
    it('prepares a saved overdue P with a distinct future recovery A', async () => {
      const [business] = await f.db<
        { next_run_at: Date }[]
      >`select next_run_at from allrice_automations where id=${c.automationId}`;
      expect(p.businessScheduledFor).toBe(business!.next_run_at.toISOString());
      expect(p.businessScheduledFor).not.toBe(a.nativeAt);
      await expect(
        store.prepareCalendarPeriod(writer, {
          controlId: c.controlId,
          expectedRevision: 1,
          periodId: randomUUID(),
          armId: randomUUID(),
          businessScheduledFor: future(),
          nativeAt: future(),
          reason: 'future_recovery',
        }),
      ).rejects.toMatchObject({ code: '23505' });
    });
    it('rejects NULL, missing discriminants, cross-period pointers and immutable P/arm edits', async () => {
      const [nulls] = await f.db<
        { control_ok: boolean; revision_ok: boolean }[]
      >`select
        allrice_native_calendar_control_valid(${f.db.json({ ...c, dispatch: { ...c.dispatch, employeeInstanceId: null } })}) control_ok,
        allrice_native_calendar_revision_valid(${f.db.json({ ...v, policyDigest: null })}) revision_ok`;
      expect(nulls).toEqual({ control_ok: false, revision_ok: false });
      await expect(
        f.db`update allrice_native_calendar_periods set current_arm_id=null,version=version+1 where period_id=${p.periodId}`,
      ).rejects.toBeDefined();
      await expect(
        f.db`update allrice_native_calendar_periods set current_arm_id=${randomUUID()},version=version+1 where period_id=${p.periodId}`,
      ).rejects.toBeDefined();
      await expect(
        f.db`update allrice_native_calendar_periods set business_scheduled_for=clock_timestamp(),version=version+1 where period_id=${p.periodId}`,
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        f.db`update allrice_native_calendar_arms set native_at=clock_timestamp(),snapshot_version=snapshot_version+1 where arm_id=${a.armId}`,
      ).rejects.toMatchObject({ code: '23514' });
      await expect(f.db`update allrice_native_recurring_controls set snapshot=snapshot #- '{control,binding}',snapshot_version=snapshot_version+1
      where control_id=${c.controlId}`).rejects.toMatchObject({
        code: '23514',
      });
      await expect(f.db`update allrice_native_recurring_controls set immutable_identity=immutable_identity-'binding',
      snapshot=jsonb_set(snapshot,'{control,kind}','"recurring"'),snapshot_version=snapshot_version+1
      where control_id=${c.controlId}`).rejects.toMatchObject({
        code: '23514',
      });
      await expect(
        f.db`delete from allrice_native_calendar_periods where period_id=${p.periodId}`,
      ).rejects.toMatchObject({ code: '23514' });
    });
    it('rearms an unstarted intent only after exact absence, retaining the same P', async () => {
      const absent = await store.confirmCalendarArmAbsent(writer, {
        ...current(),
        taskRecords: {},
      });
      p = absent.period;
      a = absent.arm;
      expect(a.absenceProof?.kind).toBe('never_started');
      const saved = p.businessScheduledFor;
      const preparation = {
        periodId: p.periodId,
        previousArmId: a.armId,
        expectedPeriodVersion: p.version,
        expectedArmVersion: a.snapshotVersion,
        armId: randomUUID(),
        nativeAt: future(),
      };
      await expect(
        f.db.begin(async (tx) => {
          await store.prepareCalendarArmInTransaction(tx, writer, preparation);
          throw Error('abort composed calendar rearm');
        }),
      ).rejects.toThrow('abort composed calendar rearm');
      expect(
        await store.readExactCalendarArm(a.armId, a.requestDigest),
      ).toMatchObject({
        state: 'absent',
        period: { version: p.version, currentArmId: a.armId },
        arm: { snapshotVersion: a.snapshotVersion, status: 'absent' },
      });
      const next = await store.prepareCalendarArm(writer, preparation);
      p = next.period;
      a = next.arm;
      expect(a.attempt).toBe(2);
      expect(p.businessScheduledFor).toBe(saved);
    });
    it('authorizes one create and refuses same-generation retries or absence', async () => {
      const started = await store.beginCalendarArmCreate(writer, current());
      p = started.period;
      a = started.arm;
      expect(started.outcome).toBe('create_authorized');
      await expect(
        store.beginCalendarArmCreate(writer, current()),
      ).rejects.toThrow('create_already_started');
      const r = await store.readExactCalendarArm(a.armId, a.requestDigest);
      expect(r).toMatchObject({
        state: 'absent',
        generationFence: {
          canCreate: false,
          absenceProved: false,
          currentEpoch: writer.epoch,
        },
      });
      await expect(
        store.confirmCalendarArmAbsent(writer, {
          ...current(),
          taskRecords: {},
        }),
      ).rejects.toThrow('generation_not_fenced');
      expect(
        await store.readExactCalendarArm(
          a.armId,
          nativeOnceDigest('wrong-request'),
        ),
      ).toEqual({ state: 'unknown' });
    });
    it('requires the exact closed old generation and the complete task set before the next attempt', async () => {
      const oldWriter = writer;
      await store.releaseClosedWriter(oldWriter);
      store = createNativeCalendarSqlStore({
        ...options,
        ownerId: randomUUID(),
      });
      const grant = await store.acquireWriter();
      writer = grant!.writer;
      expect(writer.epoch).toBe(oldWriter.epoch + 1);
      await expect(
        store.confirmCalendarArmAbsent(writer, {
          ...current(),
          taskRecords: { invented: {} },
        }),
      ).rejects.toThrow('task_set_unproved');
      const absent = await store.confirmCalendarArmAbsent(writer, {
        ...current(),
        taskRecords: {},
      });
      p = absent.period;
      a = absent.arm;
      expect(a.absenceProof).toMatchObject({
        kind: 'fenced_generation',
        closedWriter: calendarWriterIdentity(oldWriter),
      });
      const next = await store.prepareCalendarArm(writer, {
        periodId: p.periodId,
        previousArmId: a.armId,
        expectedPeriodVersion: p.version,
        expectedArmVersion: a.snapshotVersion,
        armId: randomUUID(),
        nativeAt: future(),
      });
      p = next.period;
      a = next.arm;
      const started = await store.beginCalendarArmCreate(writer, current());
      a = started.arm;
      expect(a.attempt).toBe(3);
      native = {
        sessionId: c.controlSessionId,
        status: 'active',
        record: {
          id: randomUUID(),
          kind: 'at',
          title: 'AllRice once control',
          prompt:
            'Synthetic schedule control only. Never execute business work.',
          scheduledAt: a.nativeAt,
        },
        deliveryHistory: { records: [], earlierRecordsUnavailable: false },
      };
    });
    function faultDatabase(
      after: (tx: TransactionSql) => Promise<void>,
      loseAck = false,
    ): Sql {
      return new Proxy(f.db, {
        get(target, key, receiver) {
          if (key !== 'begin') return Reflect.get(target, key, receiver);
          return async (...args: unknown[]) => {
            const callback = args.at(-1) as (
              tx: TransactionSql,
            ) => Promise<unknown>;
            const forwarded = [...args];
            forwarded[forwarded.length - 1] = async (tx: TransactionSql) => {
              const result = await callback(tx);
              await after(tx);
              return result;
            };
            const result = await Reflect.apply(target.begin, target, forwarded);
            if (loseAck) throw Error('lost calendar COMMIT ACK');
            return result;
          };
        },
      });
    }
    it('rolls back first binding and journal atomically when the COMMIT lease expires', async () => {
      const w = put(native);
      const expiring = createNativeCalendarSqlStore({
        ...options,
        db: faultDatabase(async (tx) => {
          await tx`update allrice_native_once_partitions set expires_at=clock_timestamp()+interval '20 milliseconds' where partition_id=${writer.partitionId}`;
          await tx`select pg_sleep(0.04)`;
        }),
      });
      expect(await expiring.commitMutation(writer, w)).toBe('rejected');
      expect(await store.readExactCommit(writer, w)).toBe('absent');
      const r = await store.readExactCalendarArm(a.armId, a.requestDigest);
      expect(r).toMatchObject({
        state: 'absent',
        arm: { nativeTaskId: null, status: 'creating' },
        generationFence: { canCreate: false },
      });
      expect(
        await f.db`select write_id from allrice_native_recurring_journal where write_id=${w.writeId}`,
      ).toHaveLength(0);
      expect(await store.assertWriter(writer)).toBe(true);
    });
    it('recovers a lost binding ACK by exact readback with one Task and no create reauthorization', async () => {
      const w = put(native);
      const losing = createNativeCalendarSqlStore({
        ...options,
        db: faultDatabase(async () => {}, true),
      });
      await expect(losing.commitMutation(writer, w)).rejects.toThrow(
        'lost calendar COMMIT ACK',
      );
      expect(await store.readExactCommit(writer, w)).toBe('committed');
      const r = await refresh();
      expect(r.bindWrite.writeId).toBe(w.writeId);
      expect(
        await f.db`select arm_id from allrice_native_calendar_arms where period_id=${p.periodId} and native_task_id is not null`,
      ).toHaveLength(1);
      await expect(
        store.beginCalendarArmCreate(writer, current()),
      ).rejects.toThrow('create_already_started');
      await expect(
        store.prepareCalendarArm(writer, {
          periodId: p.periodId,
          previousArmId: a.armId,
          expectedPeriodVersion: p.version,
          expectedArmVersion: a.snapshotVersion,
          armId: randomUUID(),
          nativeAt: future(),
        }),
      ).rejects.toThrow('absence_unproved');
      const bad = createNativeCalendarSqlStore({
        ...options,
        db: faultDatabase(async () => {
          throw Error('unknown SQL read');
        }),
      });
      expect(await bad.readExactCalendarArm(a.armId, a.requestDigest)).toEqual({
        state: 'unknown',
      });
    });
    it('refuses direct Task-ID replacement or unjournaled receipt writes', async () => {
      await expect(f.db`update allrice_native_calendar_arms set native_task_id=${randomUUID()},snapshot_version=snapshot_version+1
      where arm_id=${a.armId}`).rejects.toMatchObject({ code: '23514' });
      await expect(f.db`update allrice_native_calendar_arms set task_snapshot=task_snapshot-'record',snapshot_version=snapshot_version+1
      where arm_id=${a.armId}`).rejects.toMatchObject({ code: '23514' });
      await expect(f.db`update allrice_native_calendar_arms set last_write_id='invented',snapshot_version=snapshot_version+1
      where arm_id=${a.armId}`).rejects.toMatchObject({ code: '23514' });
    });
    it('atomically records the real receipt at A with one occurrence for original P', async () => {
      const next = structuredClone(native);
      next.status = 'inactive';
      next.lastDelivery = {
        scheduledAt: a.nativeAt,
        deliveredAt: new Date().toISOString(),
        messageId: randomUUID(),
      };
      next.deliveryHistory = {
        records: [{ ...next.lastDelivery, prompt: next.record.prompt }],
        earlierRecordsUnavailable: false,
      };
      const w = put(next);
      expect(await store.commitMutation(writer, w)).toBe('committed');
      expect(await store.readExactCommit(writer, w)).toBe('committed');
      await refresh();
      const [o] =
        await f.db`select * from allrice_native_recurring_occurrences where calendar_period_id=${p.periodId}`;
      expect(o).toMatchObject({
        calendar_arm_id: a.armId,
        outbox_state: 'pending',
        payload: {
          control: calendarControlIdentity(c),
          businessScheduledFor: p.businessScheduledFor,
          nativeTaskId: native.record.id,
          receipt: {
            scheduledAt: a.nativeAt,
            messageId: next.lastDelivery.messageId,
          },
        },
      });
      expect(new Date(o!.scheduled_at).toISOString()).toBe(a.nativeAt);
      expect(await store.commitMutation(writer, put(native))).toBe('committed');
      await refresh();
      expect(
        await f.db`select occurrence_id from allrice_native_recurring_occurrences where calendar_period_id=${p.periodId}`,
      ).toHaveLength(1);
    });
    it('holds the business lock before trying to lock the native partition', async () => {
      let unlock!: () => void, acquired!: () => void;
      const released = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      const locked = new Promise<void>((resolve) => {
        acquired = resolve;
      });
      const holding = f.db.begin(async (tx) => {
        await tx`select id from allrice_automations where id=${c.automationId} for update`;
        acquired();
        await released;
      });
      await locked;
      let attempted!: () => void;
      const waiting = new Promise<void>((resolve) => {
        attempted = resolve;
      });
      const probe = createNativeCalendarSqlStore({
        ...options,
        async lockAdmission(tx, controls) {
          attempted();
          return options.lockAdmission(tx, controls);
        },
      });
      const committing = probe.commitMutation(writer, put(native));
      await waiting;
      try {
        await f.db.begin(async (tx) => {
          await tx`select partition_id from allrice_native_once_partitions where partition_id=${writer.partitionId} for update nowait`;
        });
      } finally {
        unlock();
        await holding;
      }
      expect(await committing).toBe('committed');
      await refresh();
    });
    it('fails closed for business handoff until the experience proof slice exists', async () => {
      const [o] = await f.db<
        { occurrence_id: string }[]
      >`select occurrence_id from allrice_native_recurring_occurrences where calendar_period_id=${p.periodId}`;
      await expect(f.db`insert into allrice_automation_runs(id,organization_id,workspace_id,automation_id,scheduled_for,native_recurring_occurrence_id)
      values(${randomUUID()},${c.organizationId},${c.workspaceId},${c.automationId},${p.businessScheduledFor}::timestamptz,${o!.occurrence_id})`).rejects.toMatchObject(
        { code: 'P1921' },
      );
      await expect(f.db`update allrice_native_recurring_occurrences set outbox_state='enqueued',business_binding='{}'::jsonb,
      outbox_owner_id='fake',outbox_epoch=1,outbox_token_digest=${nativeOnceDigest('fake')},outbox_expires_at=clock_timestamp()+interval '1 minute'
      where occurrence_id=${o!.occurrence_id}`).rejects.toMatchObject({
        code: 'P1921',
      });
      expect(
        await f.db`select id from allrice_automation_runs where native_recurring_occurrence_id=${o!.occurrence_id}`,
      ).toHaveLength(0);
    });
  },
);
