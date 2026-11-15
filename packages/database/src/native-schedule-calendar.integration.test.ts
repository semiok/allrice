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
  NativeCalendarControlSchema,
  NativeMonthlyCalendarRevisionSchema,
  calendarControlIdentity,
  calendarWriterIdentity,
  type NativeCalendarArm,
  type NativeCalendarControl,
  type NativeCalendarPeriod,
  type NativeMonthlyCalendarRevision,
  type NativeCalendarWrite,
} from './native-schedule-calendar-state.ts';
import { createChatSession } from './workspace/service.ts';
import { dispatchNextNativeRecurringOccurrence } from './native-schedule-recurring-product.ts';
import {
  ordinaryMonthlyControl,
  lockOrdinaryMonthlyAdmissions,
} from './native-schedule-monthly.ts';
import {
  calendarPlanFor,
  insertCalendarPlanInTransaction,
} from './native-schedule-calendar-business.ts';
import {
  latestMonthlyBusinessTarget,
  nextMonthlyBusinessTarget,
} from './native-schedule-monthly-time.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';
import { AutomationConversationSnapshotSchema } from './automation-conversation.ts';
import * as client from './core/client.ts';
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
  'ordinary monthly calendar protocol, isolated SQL only (no public Host or model)',
  { timeout: 30_000 },
  () => {
    let f: Awaited<ReturnType<typeof createP27CodexWorkerFixture>>;
    let store: ReturnType<typeof createNativeCalendarSqlStore>,
      options: NativeCalendarSqlOptions;
    let c: NativeCalendarControl,
      v: NativeMonthlyCalendarRevision,
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
    let businessP: string;
    const future = () =>
      new Date(
        Math.max(Date.now(), Date.parse(businessP || '1970-01-01')) + 300_000,
      ).toISOString();
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
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
      vi.stubEnv('ALLRICE_NATIVE_RECURRING_ENABLED', '1');
      vi.stubEnv('ALLRICE_NATIVE_CALENDAR_ENABLED', '1');
      f = await createP27CodexWorkerFixture({
        allowCiDatabase: true,
        personalProfile: 'writable',
      });
      vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
      const reference = {
        artifactId: `sha256:${'a'.repeat(64)}`,
        profileId: 'allrice-recurring-control-v1' as const,
        storageId: 'sql-only-calendar-no-host',
        stateRoot: `/isolated/sql-only-calendar/${randomUUID()}`,
      };
      await f.db`insert into allrice_native_once_partitions(partition_id,reference,activation)
        values('allrice-recurring-v1',${f.db.json(reference)},${f.db.json(ready)})`;
      const session = await createChatSession(f.context, {
        workspaceId: f.workspaceId,
        employeeAssignmentId: f.assignmentId,
        title: 'SQL-only calendar',
      });
      // The first INSERT represents a valid earlier creation, as in the monthly
      // integration fixture; no immutable issued P or production clock is edited.
      const automationId = randomUUID(),
        requestId = randomUUID();
      const content = {
        name: 'SQL-only calendar',
        prompt: 'Never execute a model in this suite',
      };
      const rule = {
        kind: 'monthly' as const,
        monthDay: 31,
        time: '10:00:00',
        timezone: 'Asia/Shanghai',
      };
      const [clock] = await f.db<
        { now: Date }[]
      >`select date_trunc('milliseconds',clock_timestamp()) now`;
      const acceptedAt = new Date(
        latestMonthlyBusinessTarget(rule, clock!.now).getTime() - 1,
      );
      const dueP = nextMonthlyBusinessTarget(rule, acceptedAt);
      expect(dueP.getTime()).toBeLessThanOrEqual(clock!.now.getTime());
      c = ordinaryMonthlyControl({
        kind: 'calendar',
        binding: 'rotating-at-v1',
        partitionId: 'allrice-recurring-v1',
        controlId: randomUUID(),
        automationId,
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
          employeeInstanceId: session.employeeInstanceId,
          businessSessionId: session.id,
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
      v = NativeMonthlyCalendarRevisionSchema.parse({
        ...raw,
        reservationDigest: nativeOnceDigest({
          organizationId: f.organizationId,
          workspaceId: f.workspaceId,
          ownerId: f.ownerId,
          automationId,
          employeeAssignmentId: f.assignmentId,
          employeeInstanceId: session.employeeInstanceId,
          businessSessionId: session.id,
          ...raw,
        }),
      });
      await f.db.begin(async (tx) => {
        await tx`insert into allrice_automations(id,organization_id,workspace_id,owner_id,name,prompt,trigger_type,schedule,status,conversation_mode,employee_assignment_id,session_id,
          next_run_at,clock_owner,native_recurring_request_id,native_recurring_request_digest,native_recurring_revision,created_at)
          values(${automationId},${f.organizationId},${f.workspaceId},${f.ownerId},${content.name},${content.prompt},'schedule',${tx.json({ frequency: 'native_recurring', rule })},'enabled','reuse',${f.assignmentId},${session.id},${dueP},
          'native_recurring',${requestId},${runtimePolicyDigest({ sessionId: session.id, clientRequestId: requestId, ...content, rule })},1,${acceptedAt})`;
        await tx`insert into allrice_native_recurring_versions(automation_id,revision,configuration,business_content,business_content_digest)
          values(${automationId},1,${tx.json(v)},${tx.json(content)},${v.contentDigest})`;
        await tx`insert into allrice_native_recurring_controls(partition_id,control_id,automation_id,control_session_id,immutable_identity,snapshot)
          values(${c.partitionId},${c.controlId},${automationId},${c.controlSessionId},${tx.json(calendarControlIdentity(c))},${tx.json({ control: c, task: null })})`;
        await insertCalendarPlanInTransaction(
          tx,
          calendarPlanFor(c, v, dueP, acceptedAt, {
            kind: 'request',
            requestId,
          }),
        );
        expect(
          (
            await lockOrdinaryMonthlyAdmissions(tx, [ordinaryMonthlyControl(c)])
          ).get(c.controlId),
        ).toMatchObject({ allowed: true, currentRevision: 1 });
        const [proof] =
          await tx`select allrice_ordinary_monthly_authorized(${automationId}::uuid) authorized`;
        expect(proof!.authorized).toBe(true);
      });
      const [parent] =
        await f.db`select snapshot->'control' control from allrice_native_recurring_controls where automation_id=${automationId}`;
      const [version] =
        await f.db`select configuration from allrice_native_recurring_versions where automation_id=${automationId} and revision=1`;
      const [plan] =
        await f.db`select * from allrice_native_calendar_plans where automation_id=${automationId} and closed_decision_id is null`;
      c = NativeCalendarControlSchema.parse(parent!.control);
      v = NativeMonthlyCalendarRevisionSchema.parse(version!.configuration);
      businessP = plan!.business_scheduled_for.toISOString();
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
              consumer: 'ordinary-monthly-v1' as const,
              revisionDigest: nativeOnceDigest(v),
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
      const preparation = {
        controlId: c.controlId,
        expectedRevision: 1,
        periodId: plan!.period_id,
        armId: plan!.initial_arm_id,
        businessScheduledFor: businessP,
        planId: plan!.period_id,
        nativeAt: future(),
        reason: 'future_recovery' as const,
      };
      // All reservation effects take part in this existing business TX. This
      // test does not concatenate independently committed store methods.
      await expect(
        f.db.begin(async (tx) => {
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
      ).toHaveLength(1);
      expect(
        await f.db`select revision from allrice_native_recurring_versions where automation_id=${c.automationId}`,
      ).toHaveLength(1);
      expect(
        await f.db`select period_id from allrice_native_calendar_periods where automation_id=${c.automationId}`,
      ).toHaveLength(0);
      expect(
        await f.db`select arm_id from allrice_native_calendar_arms`,
      ).toHaveLength(0);
      const reserved = await f.db.begin(async (tx) => {
        return store.prepareCalendarPeriodInTransaction(
          tx,
          writer,
          preparation,
        );
      });
      p = reserved.period;
      a = reserved.arm;
      expect(await store.loadCalendarControls(writer)).toEqual([c]);
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
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
      }
    }, 30_000);

    it('retains the enrolled monthly clock and rejects resets to the legacy clock', async () => {
      expect(await store.loadCalendarControls(writer)).toEqual([c]);
      const readBusiness = () =>
        f.db`select * from allrice_automations where id=${c.automationId}`;
      const [business] = await readBusiness();
      expect(business).toMatchObject({
        clock_owner: 'native_recurring',
        schedule: { frequency: 'native_recurring', rule: v.rule },
        conversation_mode: 'reuse',
        next_run_at: new Date(businessP),
      });
      const fixed = createNativeRecurringSqlStore({
        ...options,
        lockAdmission: async () => new Map(),
      });
      await expect(fixed.loadControls(writer)).rejects.toThrow();
      await expect(f.db`update allrice_automations set clock_owner='legacy',native_recurring_request_id=null,
        native_recurring_request_digest=null,native_recurring_revision=null where id=${c.automationId}`).rejects.toMatchObject(
        {
          code: '23514',
          message:
            'automation conversation source/create identity is immutable',
        },
      );
      expect([...(await readBusiness())]).toEqual([business]);
      await expect(
        f.db.begin(
          (tx) =>
            tx`update allrice_automations set next_run_at=null where id=${c.automationId}`,
        ),
      ).rejects.toMatchObject({
        code: 'P1921',
        message: 'ordinary monthly lacks exact scoped immutable version/plan',
      });
      expect([...(await readBusiness())]).toEqual([business]);
      expect(
        (
          await f.db`select clock_owner from allrice_automations where id=${c.automationId}`
        )[0]!.clock_owner,
      ).toBe('native_recurring');
    });
    it('prepares the saved monthly P with a distinct recovery A and rejects a second open period', async () => {
      expect(p.businessScheduledFor).toBe(businessP);
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
        allrice_native_calendar_revision_valid(${f.db.json({ ...v, contentDigest: null })}) revision_ok`;
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
      observe: (tx: TransactionSql) => TransactionSql = (tx) => tx,
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
              // One wrapper identity flows through the real admission/queue reservation.
              const result = await callback(observe(tx));
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
    it('fails closed for business handoff without the exact monthly original-chat proof', async () => {
      const [o] = await f.db<
        { occurrence_id: string }[]
      >`select occurrence_id from allrice_native_recurring_occurrences where calendar_period_id=${p.periodId}`;
      type Boundary = {
        business: Record<string, unknown[]>;
        occurrence: Record<string, unknown>;
      };
      async function boundary(tx: Sql | TransactionSql) {
        const [row] = await tx<
          { value: Boundary }[]
        >`select jsonb_build_object('business',jsonb_build_object(
          'automations',(select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]'::jsonb) from allrice_automations x),
          'versions',(select coalesce(jsonb_agg(to_jsonb(x) order by x.automation_id,x.revision),'[]'::jsonb) from allrice_native_recurring_versions x),
          'controls',(select coalesce(jsonb_agg(to_jsonb(x) order by x.control_id),'[]'::jsonb) from allrice_native_recurring_controls x),
          'plans',(select coalesce(jsonb_agg(to_jsonb(x) order by x.period_id),'[]'::jsonb) from allrice_native_calendar_plans x),
          'periods',(select coalesce(jsonb_agg(to_jsonb(x) order by x.period_id),'[]'::jsonb) from allrice_native_calendar_periods x),
          'arms',(select coalesce(jsonb_agg(to_jsonb(x) order by x.arm_id),'[]'::jsonb) from allrice_native_calendar_arms x),
          'decisions',(select coalesce(jsonb_agg(to_jsonb(x) order by x.decision_id),'[]'::jsonb) from allrice_native_calendar_decisions x),
          'intents',(select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb) from allrice_native_calendar_retirement_intents x),
          'retirements',(select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb) from allrice_native_calendar_retirements x),
          'automationRuns',(select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]'::jsonb) from allrice_automation_runs x),
          'runs',(select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]'::jsonb) from allrice_runs x),
          'jobs',(select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]'::jsonb) from allrice_jobs x),
          'employeeRuns',(select coalesce(jsonb_agg(to_jsonb(x) order by x.run_id),'[]'::jsonb) from allrice_employee_runs x),
          'employeeSteps',(select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb) from allrice_employee_run_steps x),
          'messages',(select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]'::jsonb) from allrice_messages x),
          'sessions',(select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]'::jsonb) from allrice_chat_sessions x),
          'inputs',(select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb) from allrice_chat_input_requests x),
          'policies',(select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]'::jsonb) from allrice_policy_snapshots x),
          'events',(select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb) from allrice_run_events x),
          'audit',(select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb) from allrice_audit_events x),
          'followups',(select coalesce(jsonb_agg(to_jsonb(x) order by x.run_id),'[]'::jsonb) from allrice_conversation_followups x),
          'commands',(select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb) from allrice_conversation_commands x),
          'clocks',(select coalesce(jsonb_agg(to_jsonb(x) order by x.run_id),'[]'::jsonb) from allrice_task_clocks x),
          'assets',(select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb) from allrice_company_run_assets x)),
          'occurrence',(select to_jsonb(x) from allrice_native_recurring_occurrences x where occurrence_id=${o!.occurrence_id})) value`;
        return row!.value;
      }
      const lease = (b: Boundary) =>
        Object.fromEntries(
          [
            'outbox_owner_id',
            'outbox_epoch',
            'outbox_token_digest',
            'outbox_expires_at',
          ].map((key) => [key, b.occurrence[key]]),
        );
      const before = await boundary(f.db),
        workerId = randomUUID();
      const dispatch = ordinaryMonthlyControl(c).dispatch;
      let claimed: Boundary | undefined,
        complete: Record<string, unknown> | undefined,
        damaged: Record<string, unknown> | undefined,
        injections = 0,
        proved = false;
      const db = faultDatabase(
        async (tx) => {
          const state = await boundary(tx);
          if (injections === 0) {
            expect(state.business).toEqual(before.business);
            expect(state.occurrence).toMatchObject({
              outbox_state: 'pending',
              business_binding: null,
              outbox_owner_id: workerId,
              outbox_epoch: Number(before.occurrence.outbox_epoch) + 1,
            });
            expect(state.occurrence.outbox_token_digest).toMatch(
              /^sha256:[a-f0-9]{64}$/,
            );
            claimed = state;
            return;
          }
          expect(claimed).toBeDefined();
          expect(lease(state)).toEqual(lease(claimed!));
          const [proof] = await tx<
            {
              conversation_ok: boolean;
              monthly_ok: boolean;
              authority_ok: boolean;
              lease_live: boolean;
              conversation_snapshot: unknown;
              business_binding: unknown;
            }[]
          >`select
          allrice_automation_conversation_handoff_proved(ar.id) conversation_ok,
          allrice_ordinary_monthly_handoff_proved(o.occurrence_id) monthly_ok,
          allrice_ordinary_monthly_authorized(ar.automation_id) authority_ok,
          (o.outbox_state='enqueued' and o.outbox_expires_at>clock_timestamp()) lease_live,
          ar.conversation_snapshot,o.business_binding from allrice_native_recurring_occurrences o
          join allrice_automation_runs ar on ar.native_recurring_occurrence_id=o.occurrence_id
          where o.occurrence_id=${o!.occurrence_id}`;
          expect(proof).toMatchObject({
            conversation_ok: true,
            monthly_ok: false,
            authority_ok: true,
            lease_live: true,
          });
          expect(complete!.contentDigest).toBe(v.contentDigest);
          expect(proof!.business_binding).toEqual(damaged);
          expect(
            AutomationConversationSnapshotSchema.parse(
              proof!.conversation_snapshot,
            ),
          ).toMatchObject({
            automationId: c.automationId,
            businessRevision: 1,
            mode: 'reuse',
            sourceSessionId: dispatch.businessSessionId,
            targetSessionId: dispatch.businessSessionId,
            employeeAssignmentId: dispatch.employeeAssignmentId,
            employeeInstanceId: dispatch.employeeInstanceId,
            trigger: {
              kind: 'scheduled',
              nativeKind: 'recurring',
              occurrenceId: o!.occurrence_id,
              scheduledFor: p.businessScheduledFor,
            },
          });
          for (const name of ['automationRuns', 'runs', 'jobs', 'employeeRuns'])
            expect(state.business[name]).toHaveLength(
              before.business[name]!.length + 1,
            );
          expect(state.business.messages).toHaveLength(
            before.business.messages!.length + 2,
          );
          expect(state.business.sessions).toHaveLength(
            before.business.sessions!.length,
          );
          proved = true;
        },
        false,
        (tx) =>
          new Proxy(tx, {
            get(target, key, receiver) {
              if (key !== 'json') return Reflect.get(target, key, receiver);
              return (value: unknown) => {
                if (
                  value &&
                  typeof value === 'object' &&
                  'consumer' in value &&
                  value.consumer === 'ordinary-monthly-v1' &&
                  'periodId' in value &&
                  value.periodId === p.periodId &&
                  'automationRunId' in value
                ) {
                  expect(++injections).toBe(1);
                  complete = structuredClone(value as Record<string, unknown>);
                  const { contentDigest: omitted, ...rest } = complete;
                  expect(omitted).toBe(v.contentDigest);
                  damaged = rest;
                  return target.json(
                    rest as Parameters<TransactionSql['json']>[0],
                  );
                }
                return target.json(
                  value as Parameters<TransactionSql['json']>[0],
                );
              };
            },
          }),
      );
      vi.mocked(client.getDatabase).mockReturnValue(db);
      try {
        await expect(
          dispatchNextNativeRecurringOccurrence(workerId),
        ).rejects.toMatchObject({
          code: 'P1921',
          message:
            'ordinary monthly Run lacks exact frozen original chat handoff',
        });
      } finally {
        vi.mocked(client.getDatabase).mockReturnValue(f.db);
      }
      expect(injections).toBe(1);
      expect(proved).toBe(true);
      // The real short claim commits independently; only the business TX rolls back.
      expect(await boundary(f.db)).toEqual(claimed);
      await expect(f.db`update allrice_native_recurring_occurrences set outbox_state='enqueued',business_binding='{}'::jsonb
        where occurrence_id=${o!.occurrence_id} and outbox_owner_id=${workerId} and outbox_expires_at>clock_timestamp()`).rejects.toMatchObject(
        { code: 'P1921' },
      );
      expect(await boundary(f.db)).toEqual(claimed);
      expect(
        await f.db`select id from allrice_automation_runs where native_recurring_occurrence_id=${o!.occurrence_id}`,
      ).toHaveLength(0);
    });
  },
);
