import { isDeepStrictEqual } from 'node:util';
import type { TransactionSql } from 'postgres';
import {
  createNativeScheduleControlSqlStore,
  NativeOnceSqlError,
  type NativeScheduleControlSqlOptions,
} from './native-schedule-control-sql.ts';
import {
  nativeOnceDigest,
  type NativeOnceTask,
  type NativeOnceWriter,
} from './native-schedule-once-state.ts';
import {
  NativeCalendarArmSchema,
  NativeCalendarControlSchema,
  NativeCalendarMutationSchema,
  NativeCalendarPeriodSchema,
  NativeCalendarRevisionSchema,
  NativeCalendarStateError,
  calendarAdmissionReason,
  calendarRevisionAdmissionMatches,
  calendarArmIdentity,
  calendarArmRequestDigest,
  calendarControlIdentity,
  calendarOccurrenceIdentity,
  calendarPeriodIdentity,
  calendarWriterIdentity,
  prepareNativeCalendarTaskPut,
  requireCalendar,
  validateCalendarBinding,
  validateCalendarTask,
  type NativeCalendarAdmission,
  type NativeCalendarArm,
  type NativeCalendarControl,
  type NativeCalendarPeriod,
  type NativeCalendarRevision,
  type NativeCalendarSnapshot,
  type NativeCalendarWrite,
} from './native-schedule-calendar-state.ts';
import {
  NativeRecurringControlSchema,
  recurringControlIdentity,
  validateRecurringTask,
} from './native-schedule-recurring-state.ts';
import type { NativeRecurringPartitionControl } from './native-schedule-recurring-loader.ts';
import {
  NativeCalendarPlanSchema,
  calendarPlanDigest,
  type NativeCalendarPlan,
} from './native-schedule-calendar-business-state.ts';

export type NativeCalendarSqlOptions = Omit<
  NativeScheduleControlSqlOptions<NativeCalendarControl>,
  'loadControls'
> & {
  /** No environment flag or existing fixed Worker enables this protocol. */
  enabled?: boolean;
  /** A mixed partition injects its ONE common lifecycle. This adapter must not
   * acquire a second writer or omit fixed Sessions from workspace validation. */
  sharedBase?: ReturnType<
    typeof createNativeScheduleControlSqlStore<NativeRecurringPartitionControl>
  >;
  decodeTask: (raw: unknown) => NativeOnceTask;
  /** Acquire CURRENT business locks before any native partition/control locks.
   * Policy advisory183, if needed, must be acquired before the automation lock. */
  lockAdmission: (
    tx: TransactionSql,
    controls: readonly NativeCalendarControl[],
    purpose?: 'initialize' | 'native',
  ) => Promise<ReadonlyMap<string, NativeCalendarAdmission>>;
};
type ControlRow = {
  control_id: string;
  immutable_identity: ReturnType<typeof calendarControlIdentity>;
  snapshot: NativeCalendarSnapshot;
  snapshot_version: number | string;
};
type PeriodRow = {
  period_id: string;
  partition_id: 'allrice-recurring-v1';
  control_id: string;
  automation_id: string;
  revision: number | string;
  business_scheduled_for: Date | string;
  current_arm_id: string;
  state: NativeCalendarPeriod['state'];
  version: number | string;
  plan_id?: string | null;
  business_decision_id?: string | null;
};
type ArmRow = {
  arm_id: string;
  period_id: string;
  attempt: number | string;
  native_at: Date | string;
  reason: NativeCalendarArm['reason'];
  request_digest: string;
  status: NativeCalendarArm['status'];
  native_task_id: string | null;
  task_snapshot: unknown;
  bind_write_id: string | null;
  last_write_id: string | null;
  create_writer: NativeCalendarArm['createWriter'];
  absence_proof: NativeCalendarArm['absenceProof'];
  snapshot_version: number | string;
};
type CalendarJournal = ReturnType<
  typeof prepareNativeCalendarTaskPut
>['journal'] & {
  revisionLink?: {
    plan: NativeCalendarPlan;
    planDigest: string;
    revision: NativeCalendarRevision;
  };
  retirement?: {
    retirementId: string;
    armId: string;
    nativeTaskId: string;
    taskDigest: string;
    task: NativeOnceTask;
  };
};
type JournalRow = {
  partition_id: string;
  write_id: string;
  control_id: string;
  writer_owner_id: string;
  writer_epoch: number | string;
  writer_token_digest: string;
  reference: unknown;
  write_digest: string;
  mutation: NativeCalendarWrite['mutation'];
  journal: CalendarJournal;
  after_snapshot: NativeCalendarSnapshot;
  after_digest: string;
};
const json = (tx: TransactionSql, v: unknown) => {
  nativeOnceDigest(v);
  return tx.json(JSON.parse(JSON.stringify(v)));
};
const iso = (v: Date | string) => new Date(v).toISOString();
function period(r: PeriodRow): NativeCalendarPeriod {
  return NativeCalendarPeriodSchema.parse({
    periodId: r.period_id,
    partitionId: r.partition_id,
    controlId: r.control_id,
    automationId: r.automation_id,
    revision: Number(r.revision),
    businessScheduledFor: iso(r.business_scheduled_for),
    currentArmId: r.current_arm_id,
    state: r.state,
    version: Number(r.version),
  });
}
function arm(r: ArmRow): NativeCalendarArm {
  return NativeCalendarArmSchema.parse({
    armId: r.arm_id,
    periodId: r.period_id,
    attempt: Number(r.attempt),
    nativeAt: iso(r.native_at),
    reason: r.reason,
    requestDigest: r.request_digest,
    status: r.status,
    nativeTaskId: r.native_task_id,
    taskSnapshot: r.task_snapshot,
    bindWriteId: r.bind_write_id,
    lastWriteId: r.last_write_id,
    createWriter: r.create_writer,
    absenceProof: r.absence_proof,
    snapshotVersion: Number(r.snapshot_version),
  });
}
function control(r: ControlRow) {
  const c = NativeCalendarControlSchema.parse(r.snapshot.control);
  requireCalendar(
    r.control_id === c.controlId &&
      r.snapshot.task === null &&
      isDeepStrictEqual(r.immutable_identity, calendarControlIdentity(c)),
    'control_invalid',
  );
  nativeOnceDigest(r.snapshot);
  return c;
}
export type NativeCalendarArmRead =
  | { state: 'unknown' }
  | {
      state: 'bound';
      period: NativeCalendarPeriod;
      arm: NativeCalendarArm;
      fullTask: NativeOnceTask;
      bindWrite: NativeCalendarWrite;
      digests: {
        bindTaskDigest: string;
        taskDigest: string;
        periodDigest: string;
        armDigest: string;
      };
      lastWrite: NativeCalendarWrite;
    }
  | {
      state: 'absent';
      period: NativeCalendarPeriod;
      arm: NativeCalendarArm;
      /** SQL absence is NOT permission to repeat public create. */
      generationFence: {
        canCreate: false;
        currentEpoch: number;
        closed: boolean;
        createWriter: NativeCalendarArm['createWriter'];
        absenceProved: boolean;
      };
    };

/** Dormant SQL protocol only. It never calls public create, constructs a Host,
 * plans a calendar, switches clock_owner or dispatches an experience Run. */
export function createNativeCalendarSqlStore(
  options: NativeCalendarSqlOptions,
) {
  requireCalendar(
    options.partitionId === 'allrice-recurring-v1' &&
      options.reference.profileId === 'allrice-recurring-control-v1',
    'configuration_invalid',
  );
  const partitionId = options.partitionId;
  const reference = structuredClone(options.reference);
  const enabled = () => options.enabled === true;
  const requireEnabled = () => requireCalendar(enabled(), 'disabled');
  async function controls(tx: TransactionSql) {
    const rows = await tx<
      ControlRow[]
    >`select control_id,immutable_identity,snapshot,snapshot_version
      from allrice_native_recurring_controls where partition_id=${partitionId}
      and snapshot->'control'->>'kind'='calendar' order by control_id limit 10001`;
    requireCalendar(rows.length <= 10_000, 'control_limit');
    const sessions = new Set<string>();
    return rows.map((r) => {
      const c = control(r);
      requireCalendar(!sessions.has(c.controlSessionId), 'control_invalid');
      sessions.add(c.controlSessionId);
      return c;
    });
  }
  const base =
    options.sharedBase ??
    createNativeScheduleControlSqlStore<NativeRecurringPartitionControl>({
      ...options,
      loadControls: controls,
    });
  async function requireTaskCapacity(tx: TransactionSql) {
    const [r] = await tx<{ total: number | string }[]>`select (
      (select count(*) from allrice_native_recurring_controls where partition_id=${partitionId}
        and native_task_id is not null and snapshot->'control'->>'taskDeleted'='false') +
      (select count(*) from allrice_native_calendar_arms a join allrice_native_calendar_periods p on p.period_id=a.period_id
        where p.partition_id=${partitionId} and a.native_task_id is not null
        and not exists(select 1 from allrice_native_calendar_retirements d where d.arm_id=a.arm_id))) total`;
    requireCalendar(r && Number(r.total) < 10_000, 'task_limit');
  }
  async function revision(
    tx: TransactionSql,
    c: NativeCalendarControl,
    n: number,
  ) {
    const [r] = await tx<{ configuration: NativeCalendarRevision }[]>`
      select configuration from allrice_native_recurring_versions
      where automation_id=${c.automationId} and revision=${n}`;
    requireCalendar(r, 'revision_missing');
    const v = NativeCalendarRevisionSchema.parse(r.configuration);
    requireCalendar(v.consumer === c.dispatch.consumer, 'consumer_invalid');
    requireCalendar(v.revision === n, 'revision_missing');
    return v;
  }
  async function projection(tx: TransactionSql, controlId: string) {
    const [r] = await tx<
      ControlRow[]
    >`select control_id,immutable_identity,snapshot,snapshot_version
      from allrice_native_recurring_controls where partition_id=${partitionId} and control_id=${controlId}`;
    requireCalendar(r, 'control_missing');
    return r;
  }
  async function lockControl(
    tx: TransactionSql,
    w: NativeOnceWriter,
    controlId: string,
  ) {
    const projected = await projection(tx, controlId);
    const admissions = await options.lockAdmission(tx, [control(projected)]);
    const p = await base.partition(tx, 'update');
    await base.requireActive(tx, p, w);
    const [row] = await tx<
      ControlRow[]
    >`select control_id,immutable_identity,snapshot,snapshot_version
      from allrice_native_recurring_controls where partition_id=${partitionId} and control_id=${controlId} for update`;
    requireCalendar(
      row &&
        isDeepStrictEqual(row.immutable_identity, projected.immutable_identity),
      'control_changed',
    );
    return {
      partition: p!,
      row,
      control: control(row),
      admission: admissions.get(controlId),
    };
  }
  async function lockArm(
    tx: TransactionSql,
    w: NativeOnceWriter,
    periodId: string,
    armId: string,
  ) {
    const [projected] = await tx<
      PeriodRow[]
    >`select * from allrice_native_calendar_periods
      where partition_id=${partitionId} and period_id=${periodId}`;
    requireCalendar(projected, 'period_missing');
    const locked = await lockControl(tx, w, projected.control_id);
    const [p] = await tx<
      PeriodRow[]
    >`select * from allrice_native_calendar_periods where period_id=${periodId} for update`;
    const [a] = await tx<ArmRow[]>`select * from allrice_native_calendar_arms
      where arm_id=${armId} and period_id=${periodId} for update`;
    requireCalendar(p && a, 'arm_missing');
    const pp = period(p),
      aa = arm(a);
    validateCalendarBinding(locked.control, pp, aa);
    return { ...locked, periodRow: p, period: pp, arm: aa };
  }
  async function insertArm(
    tx: TransactionSql,
    w: NativeOnceWriter,
    a: NativeCalendarArm,
  ) {
    await tx`insert into allrice_native_calendar_arms
      (arm_id,period_id,attempt,native_at,reason,request_digest,status,native_task_id,task_snapshot,
       bind_write_id,last_write_id,create_writer,absence_proof,snapshot_version,transition_writer,reference)
      values(${a.armId},${a.periodId},${a.attempt},${a.nativeAt}::timestamptz,${a.reason},${a.requestDigest},
        'prepared',null,null,null,null,null,null,0,${json(tx, calendarWriterIdentity(w))},${json(tx, reference)})`;
  }
  function preparedArm(
    c: NativeCalendarControl,
    p: NativeCalendarPeriod,
    id: string,
    attempt: number,
    nativeAt: string,
    reason: NativeCalendarArm['reason'],
  ) {
    const identity = {
      armId: id,
      periodId: p.periodId,
      attempt,
      nativeAt,
      reason,
    };
    const a = NativeCalendarArmSchema.parse({
      ...identity,
      requestDigest: calendarArmRequestDigest(c, p, identity),
      status: 'prepared',
      nativeTaskId: null,
      taskSnapshot: null,
      bindWriteId: null,
      lastWriteId: null,
      createWriter: null,
      absenceProof: null,
      snapshotVersion: 0,
    });
    validateCalendarBinding(c, p, a);
    requireCalendar(
      reason !== 'business_target' || nativeAt === p.businessScheduledFor,
      'native_target_invalid',
    );
    return a;
  }
  async function journalRow(tx: TransactionSql, writeId: string) {
    const [r] = await tx<
      JournalRow[]
    >`select * from allrice_native_recurring_journal
      where partition_id=${partitionId} and write_id=${writeId}`;
    return r;
  }
  async function verifyJournal(tx: TransactionSql, r: JournalRow) {
    const j = r.journal;
    const m = NativeCalendarMutationSchema.parse(r.mutation);
    const c = NativeCalendarControlSchema.parse(r.after_snapshot.control);
    const [parent] = await tx<
      ControlRow[]
    >`select control_id,immutable_identity,snapshot,snapshot_version
      from allrice_native_recurring_controls where partition_id=${partitionId} and control_id=${r.control_id}`;
    const [p] = await tx<
      { reference: unknown }[]
    >`select reference from allrice_native_once_partitions where partition_id=${partitionId}`;
    requireCalendar(
      parent &&
        p &&
        r.partition_id === partitionId &&
        r.write_id === j.write.writeId &&
        r.control_id === m.controlId &&
        r.write_digest === nativeOnceDigest(m) &&
        j.write.digest === r.write_digest &&
        isDeepStrictEqual(j.write.mutation, m) &&
        isDeepStrictEqual(j.reference, reference) &&
        isDeepStrictEqual(r.reference, reference) &&
        isDeepStrictEqual(p.reference, reference) &&
        isDeepStrictEqual(j.writer, {
          partitionId,
          ownerId: r.writer_owner_id,
          epoch: Number(r.writer_epoch),
          tokenDigest: r.writer_token_digest,
        }) &&
        isDeepStrictEqual(j.identity, parent.immutable_identity) &&
        isDeepStrictEqual(j.identity, calendarControlIdentity(c)) &&
        r.after_snapshot.task === null &&
        j.afterDigest === r.after_digest &&
        r.after_digest === nativeOnceDigest(r.after_snapshot) &&
        /^sha256:[a-f0-9]{64}$/.test(j.beforeDigest) &&
        Array.isArray(j.calendarLinks) &&
        Array.isArray(j.receiptLinks) &&
        j.receiptLinks.length <= 1,
      'exact_conflict',
    );
    control(parent);
    if (m.action === 'put_task') {
      requireCalendar(j.calendarLinks.length === 1, 'exact_conflict');
      const link = j.calendarLinks[0]!;
      const pp = NativeCalendarPeriodSchema.parse(link.period);
      const aa = NativeCalendarArmSchema.parse(link.arm);
      const task = validateCalendarTask(
        c,
        pp,
        aa,
        aa.taskSnapshot,
        options.decodeTask,
      );
      const [pr] = await tx<
        PeriodRow[]
      >`select * from allrice_native_calendar_periods where period_id=${m.periodId}`;
      const [ar] = await tx<
        ArmRow[]
      >`select * from allrice_native_calendar_arms where arm_id=${m.armId} and period_id=${m.periodId}`;
      requireCalendar(pr && ar, 'exact_conflict');
      const currentP = period(pr),
        currentA = arm(ar);
      validateCalendarBinding(c, currentP, currentA);
      requireCalendar(
        pp.periodId === m.periodId &&
          aa.armId === m.armId &&
          aa.requestDigest === m.requestDigest &&
          pp.currentArmId === aa.armId &&
          pp.version === m.expectedPeriodVersion + 1 &&
          aa.snapshotVersion === m.expectedArmVersion + 1 &&
          aa.lastWriteId === r.write_id &&
          aa.nativeTaskId === task.record.id &&
          isDeepStrictEqual(task, m.task) &&
          link.taskDigest === nativeOnceDigest(task) &&
          link.periodDigest === nativeOnceDigest(pp) &&
          link.armDigest === nativeOnceDigest(aa) &&
          isDeepStrictEqual(
            calendarPeriodIdentity(currentP),
            calendarPeriodIdentity(pp),
          ) &&
          isDeepStrictEqual(
            calendarArmIdentity(currentA),
            calendarArmIdentity(aa),
          ) &&
          currentP.version >= pp.version &&
          currentA.snapshotVersion >= aa.snapshotVersion &&
          currentA.nativeTaskId === aa.nativeTaskId &&
          currentA.bindWriteId === aa.bindWriteId &&
          isDeepStrictEqual(currentA.createWriter, aa.createWriter) &&
          (currentA.lastWriteId !== r.write_id ||
            (isDeepStrictEqual(currentP, pp) &&
              isDeepStrictEqual(currentA, aa))),
        'exact_conflict',
      );
      const v = await revision(tx, c, pp.revision);
      if (task.lastDelivery) {
        const identity = calendarOccurrenceIdentity(
          c.automationId,
          pp.periodId,
          pp.businessScheduledFor,
        );
        const payload = {
          control: calendarControlIdentity(c),
          revision: v,
          calendar: {
            period: calendarPeriodIdentity(pp),
            arm: calendarArmIdentity(aa),
          },
          businessScheduledFor: pp.businessScheduledFor,
          nativeTaskId: task.record.id,
          receipt: task.deliveryHistory?.records[0] ?? task.lastDelivery,
        };
        const expectedLink = {
          id: identity.id,
          key: identity.key,
          payloadDigest: nativeOnceDigest(payload),
        };
        requireCalendar(
          j.receiptLinks.length === 0 ||
            isDeepStrictEqual(j.receiptLinks, [expectedLink]),
          'exact_conflict',
        );
        const [o] = await tx<
          {
            automation_id: string;
            revision: number | string;
            scheduled_at: Date | string;
            client_message_id: string;
            occurrence_key: string;
            payload_digest: string;
            payload: unknown;
            calendar_period_id: string;
            calendar_arm_id: string;
          }[]
        >`
          select automation_id,revision,scheduled_at,client_message_id,occurrence_key,payload_digest,payload,calendar_period_id,calendar_arm_id
          from allrice_native_recurring_occurrences where partition_id=${partitionId}
          and control_id=${c.controlId} and occurrence_id=${identity.id}`;
        requireCalendar(
          o &&
            o.automation_id === c.automationId &&
            Number(o.revision) === pp.revision &&
            iso(o.scheduled_at) === aa.nativeAt &&
            o.client_message_id === identity.clientMessageId &&
            o.occurrence_key === identity.key &&
            o.payload_digest === expectedLink.payloadDigest &&
            o.calendar_period_id === pp.periodId &&
            o.calendar_arm_id === aa.armId &&
            nativeOnceDigest(o.payload) === expectedLink.payloadDigest &&
            isDeepStrictEqual(o.payload, payload),
          'exact_conflict',
        );
      } else requireCalendar(j.receiptLinks.length === 0, 'exact_conflict');
    } else {
      requireCalendar(
        j.calendarLinks.length === 0 && j.receiptLinks.length === 0,
        'exact_conflict',
      );
      if (m.action === 'apply_revision') {
        const [plan] = await tx<
          { plan: NativeCalendarPlan; plan_digest: string }[]
        >`
          select plan,plan_digest from allrice_native_calendar_plans where period_id=${m.planId}`;
        requireCalendar(
          plan &&
            j.revisionLink &&
            c.revision === m.revision &&
            j.revisionLink.planDigest === m.planDigest &&
            plan.plan_digest === m.planDigest &&
            calendarPlanDigest(plan.plan) === m.planDigest &&
            isDeepStrictEqual(j.revisionLink.plan, plan.plan) &&
            isDeepStrictEqual(
              j.revisionLink.revision,
              await revision(tx, c, m.revision),
            ),
          'exact_conflict',
        );
      } else if (m.action === 'retire_task') {
        const [retired] = await tx<
          {
            arm_id: string;
            native_task_id: string;
            task_snapshot: unknown;
            task_digest: string;
            write_id: string;
          }[]
        >`
          select * from allrice_native_calendar_retirements where retirement_id=${m.retirementId}
            and partition_id=${partitionId} and control_id=${c.controlId}`;
        requireCalendar(
          retired &&
            j.retirement &&
            retired.write_id === r.write_id &&
            retired.arm_id === m.armId &&
            retired.native_task_id === m.nativeTaskId &&
            retired.task_digest === m.taskDigest &&
            nativeOnceDigest(retired.task_snapshot) === m.taskDigest &&
            isDeepStrictEqual(j.retirement, {
              retirementId: m.retirementId,
              armId: m.armId,
              nativeTaskId: m.nativeTaskId,
              taskDigest: m.taskDigest,
              task: retired.task_snapshot,
            }),
          'exact_conflict',
        );
      } else
        requireCalendar(!j.revisionLink && !j.retirement, 'exact_conflict');
    }
    return r;
  }
  async function exact(
    tx: TransactionSql,
    w: NativeOnceWriter,
    write: NativeCalendarWrite,
  ) {
    if (
      w.partitionId !== partitionId ||
      write.digest !== nativeOnceDigest(write.mutation)
    )
      return 'unknown' as const;
    const r = await journalRow(tx, write.writeId);
    if (!r) return 'absent' as const;
    await verifyJournal(tx, r);
    requireCalendar(
      isDeepStrictEqual(r.journal.write, write) &&
        isDeepStrictEqual(r.journal.writer, calendarWriterIdentity(w)),
      'exact_conflict',
    );
    return 'committed' as const;
  }
  async function insertJournal(
    tx: TransactionSql,
    w: NativeOnceWriter,
    write: NativeCalendarWrite,
    after: NativeCalendarSnapshot,
    j: CalendarJournal,
  ) {
    await tx`insert into allrice_native_recurring_journal
      (partition_id,write_id,control_id,writer_owner_id,writer_epoch,writer_token_digest,
       reference,write_digest,mutation,journal,after_snapshot,after_digest)
      values(${partitionId},${write.writeId},${write.mutation.controlId},${w.ownerId},${w.epoch},
        ${nativeOnceDigest(w.token)},${json(tx, reference)},${write.digest},${json(tx, write.mutation)},
        ${json(tx, j)},${json(tx, after)},${j.afterDigest})`;
  }
  async function commitMutation(
    given: NativeOnceWriter,
    raw: NativeCalendarWrite,
    transaction?: TransactionSql,
  ): Promise<'committed' | 'rejected'> {
    if (!enabled()) return 'rejected';
    const w = structuredClone(given),
      write = structuredClone(raw);
    try {
      NativeCalendarMutationSchema.parse(write.mutation);
      requireCalendar(
        typeof write.writeId === 'string' &&
          write.writeId.length > 0 &&
          write.writeId.length <= 512 &&
          write.digest === nativeOnceDigest(write.mutation),
        'write_invalid',
      );
      const work = async (
        tx: TransactionSql,
      ): Promise<'committed' | 'rejected'> => {
        const prior = await exact(tx, w, write);
        if (prior === 'committed') return prior;
        requireCalendar(prior === 'absent', 'exact_conflict');
        const m = write.mutation;
        if (m.action === 'retire_task') {
          const locked = await lockArm(tx, w, m.periodId, m.armId);
          const { control: c, period: pp, arm: aa, partition: p } = locked;
          const [intent] = await tx<
            { retirement_id: string; record_digest: string }[]
          >`
            select i.retirement_id,i.record_digest from allrice_native_calendar_retirement_intents i
            join allrice_native_calendar_periods p on p.period_id=${pp.periodId} and p.business_decision_id=i.decision_id
            where i.retirement_id=${m.retirementId} and i.arm_id=${aa.armId} and i.native_task_id=${m.nativeTaskId}`;
          const task = validateCalendarTask(
            c,
            pp,
            aa,
            aa.taskSnapshot,
            options.decodeTask,
          );
          requireCalendar(
            intent &&
              m.controlId === c.controlId &&
              aa.nativeTaskId === m.nativeTaskId &&
              aa.snapshotVersion === m.expectedArmVersion &&
              nativeOnceDigest(task) === m.taskDigest &&
              nativeOnceDigest(task.record) === intent.record_digest,
            'retirement_conflict',
          );
          const j: CalendarJournal = {
            writer: calendarWriterIdentity(w),
            reference,
            write,
            identity: calendarControlIdentity(c),
            beforeDigest: nativeOnceDigest({ control: c, period: pp, arm: aa }),
            afterDigest: nativeOnceDigest(locked.row.snapshot),
            calendarLinks: [],
            receiptLinks: [],
            retirement: {
              retirementId: m.retirementId,
              armId: aa.armId,
              nativeTaskId: m.nativeTaskId,
              taskDigest: m.taskDigest,
              task,
            },
          };
          await tx`insert into allrice_native_calendar_retirements
            (retirement_id,arm_id,partition_id,control_id,native_task_id,task_snapshot,task_digest,write_id)
            values(${m.retirementId},${aa.armId},${partitionId},${c.controlId},${m.nativeTaskId},${json(tx, task)},${m.taskDigest},${write.writeId})`;
          await insertJournal(tx, w, write, locked.row.snapshot, j);
          await base.requireActive(tx, p, w);
          return 'committed';
        }
        if (m.action !== 'put_task') {
          const locked = await lockControl(tx, w, m.controlId);
          const { row, control: c, partition: p } = locked;
          const recheck = await exact(tx, w, write);
          if (recheck === 'committed') return recheck;
          requireCalendar(
            recheck === 'absent' &&
              Number(row.snapshot_version) === m.expectedControlVersion,
            'snapshot_cas',
          );
          const next = structuredClone(row.snapshot);
          let revisionLink: CalendarJournal['revisionLink'];
          if (m.action === 'apply_revision') {
            const [planned] = await tx<
              { plan: NativeCalendarPlan; plan_digest: string }[]
            >`
              select plan,plan_digest from allrice_native_calendar_plans where period_id=${m.planId}
                and control_id=${c.controlId} and revision=${m.revision} and closed_decision_id is null for share`;
            const v = await revision(tx, c, m.revision);
            requireCalendar(
              planned &&
                m.revision > c.revision &&
                c.sessionState === 'ready' &&
                planned.plan_digest === m.planDigest &&
                calendarPlanDigest(planned.plan) === m.planDigest &&
                locked.admission?.allowed &&
                locked.admission.currentRevision === m.revision &&
                calendarRevisionAdmissionMatches(v, locked.admission),
              'revision_changed',
            );
            next.control.revision = m.revision;
            revisionLink = {
              plan: NativeCalendarPlanSchema.parse(planned.plan),
              planDigest: m.planDigest,
              revision: v,
            };
          } else if (m.action === 'session_initializing') {
            requireCalendar(
              c.sessionState === 'reserved' ||
                c.sessionState === 'initializing',
              'session_transition',
            );
            next.control.sessionState = 'initializing';
          } else {
            requireCalendar(
              c.sessionState === 'initializing' || c.sessionState === 'ready',
              'session_transition',
            );
            next.control.sessionState = 'ready';
          }
          NativeCalendarControlSchema.parse(next.control);
          const j: CalendarJournal = {
            writer: calendarWriterIdentity(w),
            reference,
            write,
            identity: calendarControlIdentity(c),
            beforeDigest: nativeOnceDigest(row.snapshot),
            afterDigest: nativeOnceDigest(next),
            calendarLinks: [],
            receiptLinks: [],
            ...(revisionLink ? { revisionLink } : {}),
          };
          const updated =
            await tx`update allrice_native_recurring_controls set snapshot=${json(tx, next)},
            calendar_last_write_id=${write.writeId},snapshot_version=snapshot_version+1 where partition_id=${partitionId} and control_id=${c.controlId}
            and snapshot_version=${m.expectedControlVersion} returning control_id`;
          requireCalendar(updated.length === 1, 'snapshot_cas');
          await insertJournal(tx, w, write, next, j);
          await base.requireActive(tx, p, w);
          return 'committed';
        }
        const locked = await lockArm(tx, w, m.periodId, m.armId);
        const { control: c, period: pp, arm: aa, partition: p } = locked;
        const [retired] =
          await tx`select 1 from allrice_native_calendar_retirements where arm_id=${aa.armId}`;
        requireCalendar(!retired, 'task_retired');
        requireCalendar(m.controlId === c.controlId, 'write_invalid');
        const recheck = await exact(tx, w, write);
        if (recheck === 'committed') return recheck;
        requireCalendar(recheck === 'absent', 'exact_conflict');
        const planned = prepareNativeCalendarTaskPut({
          readiness: base.readiness(p),
          reference,
          writerRow: base.asWriterRow(p),
          writer: w,
          dbNowMs: await base.requireActive(tx, p, w),
          control: c,
          period: pp,
          arm: aa,
          revision: await revision(tx, c, pp.revision),
          write,
          decodeTask: options.decodeTask,
          admission: locked.admission,
        });
        for (const o of planned.occurrences) {
          await tx`insert into allrice_native_recurring_occurrences
            (occurrence_id,partition_id,control_id,automation_id,revision,scheduled_at,occurrence_key,
             client_message_id,payload_digest,payload,outbox_state,outbox_reason,calendar_period_id,calendar_arm_id)
            values(${o.id},${partitionId},${c.controlId},${c.automationId},${pp.revision},
              ${o.payload.receipt.scheduledAt}::timestamptz,${o.key},${o.clientMessageId},${o.payloadDigest},
              ${json(tx, o.payload)},${o.state},${o.reason},${pp.periodId},${aa.armId})`;
        }
        const updatedA =
          await tx`update allrice_native_calendar_arms set status=${planned.arm.status},
          native_task_id=${planned.arm.nativeTaskId},task_snapshot=${json(tx, planned.arm.taskSnapshot)},
          bind_write_id=${planned.arm.bindWriteId},last_write_id=${write.writeId},snapshot_version=snapshot_version+1,
          transition_writer=${json(tx, calendarWriterIdentity(w))}
          where arm_id=${aa.armId} and snapshot_version=${m.expectedArmVersion} returning arm_id`;
        const updatedP =
          await tx`update allrice_native_calendar_periods set state=${planned.period.state},version=version+1
          where period_id=${pp.periodId} and current_arm_id=${aa.armId} and version=${m.expectedPeriodVersion} returning period_id`;
        requireCalendar(
          updatedA.length === 1 && updatedP.length === 1,
          'snapshot_cas',
        );
        await insertJournal(tx, w, write, planned.after, planned.journal);
        await base.requireActive(tx, p, w);
        return 'committed';
      };
      return transaction ? await work(transaction) : await base.bounded(work);
    } catch (e) {
      if (
        e instanceof NativeCalendarStateError ||
        e instanceof NativeOnceSqlError ||
        (e && typeof e === 'object' && 'code' in e && e.code === 'P1920')
      )
        return 'rejected';
      // Unknown COMMIT is never converted into a new create command.
      throw e;
    }
  }
  /** Composable reservation, never a native create authorization. The caller
   * owns COMMIT and must keep policy/advisory183 -> business -> native order.
   * These exact implementations also back the bounded convenience methods. */
  async function initializeControlInTransaction(
    tx: TransactionSql,
    input: {
      control: NativeCalendarControl;
      revision: NativeCalendarRevision;
    },
  ) {
    requireEnabled();
    const c = NativeCalendarControlSchema.parse(structuredClone(input.control));
    const v = NativeCalendarRevisionSchema.parse(
      structuredClone(input.revision),
    );
    // This initializer retains the original experience handoff contract.
    // Ordinary product enrollment reserves its own parent/version/P intent in
    // the authenticated Web transaction, without a native writer token.
    requireCalendar(
      c.dispatch.consumer === 'experience-consolidation-v1' &&
        v.consumer === 'experience-consolidation-v1',
      'initializer_consumer_invalid',
    );
    requireCalendar(
      c.sessionState === 'reserved' &&
        c.revision === v.revision &&
        isDeepStrictEqual(c.reference, reference),
      'reservation_invalid',
    );
    const admissions = await options.lockAdmission(tx, [c], 'initialize');
    const a = admissions.get(c.controlId);
    requireCalendar(
      a?.allowed &&
        a.status === 'enabled' &&
        a.currentRevision === v.revision &&
        calendarRevisionAdmissionMatches(v, a),
      'authority_changed',
    );
    const [business] = await tx<
      {
        organization_id: string;
        workspace_id: string;
        owner_id: string;
        employee_assignment_id: string;
        revision: number;
        schedule: unknown;
        clock_owner: string;
        status: string;
        deleted_at: unknown;
        experience_binding: {
          schemaVersion: number;
          instanceId: string;
          policyDigest: string;
        } | null;
      }[]
    >`select * from allrice_automations where id=${c.automationId} for update`;
    requireCalendar(
      business &&
        business.organization_id === c.organizationId &&
        business.workspace_id === c.workspaceId &&
        business.owner_id === c.ownerId &&
        business.employee_assignment_id === c.dispatch.employeeAssignmentId &&
        Number(business.revision) === v.revision &&
        isDeepStrictEqual(business.schedule, v.schedule) &&
        business.status === 'enabled' &&
        business.deleted_at === null &&
        business.clock_owner === 'legacy' &&
        isDeepStrictEqual(business.experience_binding, {
          schemaVersion: 1,
          instanceId: c.dispatch.employeeInstanceId,
          policyDigest: v.policyDigest,
        }),
      'business_binding_invalid',
    );
    const [instance] = await tx`select id from allrice_employee_instances
          where id=${c.dispatch.employeeInstanceId} and assignment_id=${c.dispatch.employeeAssignmentId}
          and organization_id=${c.organizationId} and workspace_id=${c.workspaceId} and owner_id=${c.ownerId}
          and archived_at is null for share`;
    requireCalendar(instance, 'business_binding_invalid');
    const p = await base.partition(tx, 'update');
    requireCalendar(
      p && isDeepStrictEqual(p.reference, reference),
      'reference_changed',
    );
    const [old] = await tx<
      ControlRow[]
    >`select control_id,immutable_identity,snapshot,snapshot_version
          from allrice_native_recurring_controls where automation_id=${c.automationId} for update`;
    if (old) {
      requireCalendar(
        isDeepStrictEqual(
          calendarControlIdentity(control(old)),
          calendarControlIdentity(c),
        ),
        'reservation_conflict',
      );
      requireCalendar(
        isDeepStrictEqual(await revision(tx, c, v.revision), v),
        'reservation_conflict',
      );
      return structuredClone(old.snapshot);
    }
    const [count] = await tx<{ total: number | string }[]>`select count(*) total
          from allrice_native_recurring_controls where partition_id=${partitionId}`;
    requireCalendar(count && Number(count.total) < 10_000, 'control_limit');
    await tx`insert into allrice_native_recurring_versions(automation_id,revision,configuration)
          values(${c.automationId},${v.revision},${json(tx, v)})`;
    const snapshot: NativeCalendarSnapshot = { control: c, task: null };
    await tx`insert into allrice_native_recurring_controls
          (partition_id,control_id,automation_id,control_session_id,native_task_id,immutable_identity,snapshot)
          values(${partitionId},${c.controlId},${c.automationId},${c.controlSessionId},null,
            ${json(tx, calendarControlIdentity(c))},${json(tx, snapshot)})`;
    return snapshot;
  }

  /** Worker materializer only: retains the actual live writer prerequisite.
   * This does not mint a writer for Web policy updates or implement successor N. */
  async function prepareCalendarPeriodInTransaction(
    tx: TransactionSql,
    w: NativeOnceWriter,
    input: {
      controlId: string;
      expectedRevision: number;
      periodId: string;
      armId: string;
      businessScheduledFor: string;
      nativeAt: string;
      reason: NativeCalendarArm['reason'];
      planId?: string;
    },
  ) {
    requireEnabled();
    const l = await lockControl(tx, w, input.controlId);
    const pp = NativeCalendarPeriodSchema.parse({
      periodId: input.periodId,
      partitionId,
      controlId: input.controlId,
      automationId: l.control.automationId,
      revision: input.expectedRevision,
      businessScheduledFor: input.businessScheduledFor,
      currentArmId: input.armId,
      state: 'prepared',
      version: 0,
    });
    const v = await revision(tx, l.control, pp.revision);
    requireCalendar(
      l.control.revision === input.expectedRevision &&
        calendarAdmissionReason(pp, v, l.admission) === null,
      'authority_changed',
    );
    const aa = preparedArm(
      l.control,
      pp,
      input.armId,
      1,
      input.nativeAt,
      input.reason,
    );
    if (input.planId) {
      const [plan] = await tx<
        { plan: NativeCalendarPlan; plan_digest: string }[]
      >`
        select plan,plan_digest from allrice_native_calendar_plans where period_id=${input.planId}
          and closed_decision_id is null for update`;
      requireCalendar(
        plan &&
          input.planId === pp.periodId &&
          plan.plan.periodId === pp.periodId &&
          plan.plan.controlId === pp.controlId &&
          plan.plan.automationId === pp.automationId &&
          plan.plan.revision === pp.revision &&
          plan.plan.businessScheduledFor === pp.businessScheduledFor &&
          plan.plan.initialArmId === aa.armId &&
          calendarPlanDigest(plan.plan) === plan.plan_digest,
        'plan_changed',
      );
    }
    const now = await base.requireActive(tx, l.partition, w);
    requireCalendar(
      aa.reason !== 'future_recovery' || Date.parse(aa.nativeAt) > now,
      'recovery_not_future',
    );
    await tx`insert into allrice_native_calendar_periods
          (period_id,partition_id,control_id,automation_id,revision,business_scheduled_for,current_arm_id,state,version,plan_id)
          values(${pp.periodId},${partitionId},${pp.controlId},${pp.automationId},${pp.revision},
            ${pp.businessScheduledFor}::timestamptz,${pp.currentArmId},'prepared',0,${input.planId ?? null})`;
    await insertArm(tx, w, aa);
    return { period: pp, arm: aa };
  }

  async function prepareCalendarArmInTransaction(
    tx: TransactionSql,
    w: NativeOnceWriter,
    input: {
      periodId: string;
      previousArmId: string;
      expectedPeriodVersion: number;
      expectedArmVersion: number;
      armId: string;
      nativeAt: string;
    },
  ) {
    requireEnabled();
    const l = await lockArm(tx, w, input.periodId, input.previousArmId);
    const pp = l.period,
      old = l.arm;
    const v = await revision(tx, l.control, pp.revision);
    requireCalendar(
      calendarAdmissionReason(pp, v, l.admission) === null,
      'authority_changed',
    );
    requireCalendar(!l.periodRow.business_decision_id, 'period_decided');
    requireCalendar(
      pp.currentArmId === old.armId &&
        pp.state === 'recovery_required' &&
        old.status === 'absent' &&
        old.absenceProof &&
        old.nativeTaskId === null &&
        pp.version === input.expectedPeriodVersion &&
        old.snapshotVersion === input.expectedArmVersion,
      'absence_unproved',
    );
    const nextP: NativeCalendarPeriod = {
      ...pp,
      currentArmId: input.armId,
      state: 'prepared',
      version: pp.version + 1,
    };
    const aa = preparedArm(
      l.control,
      nextP,
      input.armId,
      old.attempt + 1,
      input.nativeAt,
      'future_recovery',
    );
    requireCalendar(
      Date.parse(aa.nativeAt) > (await base.requireActive(tx, l.partition, w)),
      'recovery_not_future',
    );
    await insertArm(tx, w, aa);
    const updated =
      await tx`update allrice_native_calendar_periods set current_arm_id=${aa.armId},state='prepared',version=version+1
          where period_id=${pp.periodId} and current_arm_id=${old.armId} and version=${pp.version} returning period_id`;
    requireCalendar(updated.length === 1, 'snapshot_cas');
    return { period: nextP, arm: aa };
  }

  async function loadTaskRecordsInTransaction(tx: TransactionSql) {
    requireEnabled();
    const records: Record<string, NativeOnceTask> = Object.create(null);
    const rows = await tx<
      ArmRow[]
    >`select a.* from allrice_native_calendar_arms a
      join allrice_native_calendar_periods p on p.period_id=a.period_id
      where p.partition_id=${partitionId} and a.native_task_id is not null
      and not exists(select 1 from allrice_native_calendar_retirements d
        where d.arm_id=a.arm_id) order by a.arm_id limit 10001`;
    requireCalendar(rows.length <= 10_000, 'task_limit');
    for (const row of rows) {
      const aa = arm(row);
      const [pr] = await tx<
        PeriodRow[]
      >`select * from allrice_native_calendar_periods
        where period_id=${aa.periodId} and partition_id=${partitionId}`;
      requireCalendar(pr, 'period_missing');
      const c = control(await projection(tx, pr.control_id));
      const first = await journalRow(tx, aa.bindWriteId!);
      const last = await journalRow(tx, aa.lastWriteId!);
      requireCalendar(first && last, 'exact_conflict');
      await verifyJournal(tx, first);
      await verifyJournal(tx, last);
      requireCalendar(
        isDeepStrictEqual(last.journal.calendarLinks[0]?.period, period(pr)) &&
          isDeepStrictEqual(last.journal.calendarLinks[0]?.arm, aa),
        'exact_conflict',
      );
      const task = validateCalendarTask(
        c,
        period(pr),
        aa,
        aa.taskSnapshot,
        options.decodeTask,
      );
      requireCalendar(!Object.hasOwn(records, task.record.id), 'task_conflict');
      records[task.record.id] = task;
    }
    return records;
  }

  return {
    loadTaskRecordsInTransaction,
    commitMutationInTransaction: (
      tx: TransactionSql,
      w: NativeOnceWriter,
      write: NativeCalendarWrite,
    ) => commitMutation(w, write, tx),
    /** Business code composes its locks and native prepare in this SAME primary
     * transaction. It must take business locks before calling native helpers. */
    withTransaction: base.bounded,
    async loadCalendarState(w: NativeOnceWriter) {
      requireEnabled();
      return base.bounded(async (tx) => {
        const p = await base.partition(tx, 'share');
        await base.requireActive(tx, p, w);
        const parents = await tx<
          ControlRow[]
        >`select control_id,immutable_identity,snapshot,snapshot_version
          from allrice_native_recurring_controls where partition_id=${partitionId}
          and snapshot->'control'->>'kind'='calendar' order by control_id limit 10001`;
        requireCalendar(parents.length <= 10_000, 'control_limit');
        const bindings = [];
        const ps = await tx<
          PeriodRow[]
        >`select p.* from allrice_native_calendar_periods p
          join allrice_native_calendar_arms a on a.arm_id=p.current_arm_id and a.period_id=p.period_id
          where p.partition_id=${partitionId} and (p.business_decision_id is null or a.status='creating'
            or (a.native_task_id is not null and not exists(select 1 from allrice_native_calendar_retirements d where d.arm_id=a.arm_id)))
          order by p.period_id limit 10001`;
        requireCalendar(ps.length <= 10_000, 'task_limit');
        for (const pr of ps) {
          const [ar] = await tx<
            ArmRow[]
          >`select * from allrice_native_calendar_arms where arm_id=${pr.current_arm_id}`;
          requireCalendar(ar, 'arm_missing');
          const pp = period(pr),
            aa = arm(ar);
          const c = parents.find((r) => r.control_id === pr.control_id);
          requireCalendar(c, 'control_missing');
          validateCalendarBinding(control(c), pp, aa);
          const [intent] = await tx<
            { retirement_id: string; record_digest: string }[]
          >`
            select retirement_id,record_digest from allrice_native_calendar_retirement_intents where arm_id=${aa.armId}`;
          bindings.push({
            period: pp,
            arm: aa,
            closed:
              pr.business_decision_id !== null &&
              pr.business_decision_id !== undefined,
            retirement: intent
              ? {
                  retirementId: intent.retirement_id,
                  recordDigest: intent.record_digest,
                }
              : null,
          });
        }
        await base.requireActive(tx, p, w);
        return {
          controls: parents.map((r) => ({
            control: control(r),
            version: Number(r.snapshot_version),
          })),
          bindings,
        };
      });
    },
    async readExactCalendarRetirement(retirementId: string) {
      if (!enabled()) return 'unknown' as const;
      try {
        return await base.bounded(async (tx) => {
          const [r] = await tx<
            { write_id: string }[]
          >`select write_id from allrice_native_calendar_retirements
            where retirement_id=${retirementId} and partition_id=${partitionId}`;
          if (!r) return 'absent' as const;
          const j = await journalRow(tx, r.write_id);
          requireCalendar(
            j &&
              j.mutation.action === 'retire_task' &&
              j.mutation.retirementId === retirementId,
            'exact_conflict',
          );
          await verifyJournal(tx, j);
          return 'committed' as const;
        }, true);
      } catch {
        return 'unknown' as const;
      }
    },
    initializeControlInTransaction,
    prepareCalendarPeriodInTransaction,
    prepareCalendarArmInTransaction,

    async initializeControl(
      input: Parameters<typeof initializeControlInTransaction>[1],
    ) {
      requireEnabled();
      return base.bounded((tx) => initializeControlInTransaction(tx, input));
    },
    async acquireWriter() {
      return enabled() ? base.acquireWriter() : null;
    },
    async renewWriter(w: NativeOnceWriter) {
      requireEnabled();
      return base.renewWriter(w);
    },
    async assertWriter(w: NativeOnceWriter) {
      requireEnabled();
      return base.assertWriter(w);
    },
    async releaseClosedWriter(w: NativeOnceWriter) {
      requireEnabled();
      return base.releaseClosedWriter(w);
    },
    async loadCalendarControls(w: NativeOnceWriter) {
      requireEnabled();
      return (await base.loadControls(w)).filter(
        (c): c is NativeCalendarControl => c.kind === 'calendar',
      );
    },
    async prepareCalendarPeriod(
      w: NativeOnceWriter,
      input: Parameters<typeof prepareCalendarPeriodInTransaction>[2],
    ) {
      requireEnabled();
      return base.bounded((tx) =>
        prepareCalendarPeriodInTransaction(tx, w, input),
      );
    },
    async beginCalendarArmCreate(
      w: NativeOnceWriter,
      input: {
        periodId: string;
        armId: string;
        requestDigest: string;
        expectedPeriodVersion: number;
        expectedArmVersion: number;
      },
    ) {
      requireEnabled();
      return base.bounded(async (tx) => {
        const l = await lockArm(tx, w, input.periodId, input.armId);
        const pp = l.period,
          aa = l.arm;
        requireCalendar(!l.periodRow.business_decision_id, 'period_decided');
        const v = await revision(tx, l.control, pp.revision);
        requireCalendar(
          calendarAdmissionReason(pp, v, l.admission) === null,
          'authority_changed',
        );
        requireCalendar(
          pp.currentArmId === aa.armId &&
            pp.state === 'prepared' &&
            aa.status === 'prepared' &&
            aa.requestDigest === input.requestDigest &&
            pp.version === input.expectedPeriodVersion &&
            aa.snapshotVersion === input.expectedArmVersion,
          'create_already_started',
        );
        requireCalendar(
          Date.parse(aa.nativeAt) >
            (await base.requireActive(tx, l.partition, w)),
          'target_not_future',
        );
        await requireTaskCapacity(tx);
        const updated =
          await tx`update allrice_native_calendar_arms set status='creating',
          create_writer=${json(tx, calendarWriterIdentity(w))},transition_writer=${json(tx, calendarWriterIdentity(w))},
          snapshot_version=snapshot_version+1 where arm_id=${aa.armId} and status='prepared'
          and snapshot_version=${input.expectedArmVersion} returning arm_id`;
        requireCalendar(updated.length === 1, 'snapshot_cas');
        const next = NativeCalendarArmSchema.parse({
          ...aa,
          status: 'creating',
          createWriter: calendarWriterIdentity(w),
          snapshotVersion: aa.snapshotVersion + 1,
        });
        // Only this successful transition authorizes ONE public create call.
        // Lost ACK/readback of "creating" never reissues that authorization.
        return { outcome: 'create_authorized' as const, period: pp, arm: next };
      });
    },
    async confirmCalendarArmAbsent(
      w: NativeOnceWriter,
      input: {
        periodId: string;
        armId: string;
        requestDigest: string;
        expectedPeriodVersion: number;
        expectedArmVersion: number;
        /** Complete public catalog values, not list(active) or an empty projection. */
        taskRecords: Record<string, unknown>;
      },
    ) {
      requireEnabled();
      return base.bounded(async (tx) => {
        const l = await lockArm(tx, w, input.periodId, input.armId);
        const pp = l.period,
          aa = l.arm;
        requireCalendar(
          pp.currentArmId === aa.armId &&
            pp.state === 'prepared' &&
            ['prepared', 'creating'].includes(aa.status) &&
            aa.nativeTaskId === null &&
            aa.requestDigest === input.requestDigest &&
            pp.version === input.expectedPeriodVersion &&
            aa.snapshotVersion === input.expectedArmVersion,
          'absence_conflict',
        );
        // Compare the entire authoritative Task document, including inactive
        // history and fixed controls. A catalog-empty observation is insufficient.
        const expected: Record<string, unknown> = {};
        const fixed = await tx<
          {
            snapshot: { control: unknown; task: unknown };
            immutable_identity: unknown;
          }[]
        >`
          select snapshot,immutable_identity from allrice_native_recurring_controls where partition_id=${partitionId}
          and snapshot->'control'->>'kind'='recurring' order by control_id limit 10001`;
        requireCalendar(fixed.length <= 10_000, 'task_limit');
        for (const r of fixed) {
          const c = NativeRecurringControlSchema.parse(r.snapshot.control);
          requireCalendar(
            isDeepStrictEqual(
              recurringControlIdentity(c),
              r.immutable_identity,
            ),
            'control_invalid',
          );
          if (r.snapshot.task !== null) {
            const t = validateRecurringTask(
              c,
              r.snapshot.task,
              options.decodeTask,
            );
            requireCalendar(
              !Object.hasOwn(expected, t.record.id),
              'task_conflict',
            );
            expected[t.record.id] = t;
          }
        }
        const bound = await tx<
          ArmRow[]
        >`select a.* from allrice_native_calendar_arms a
          join allrice_native_calendar_periods p on p.period_id=a.period_id
          where p.partition_id=${partitionId} and a.native_task_id is not null
          and not exists(select 1 from allrice_native_calendar_retirements d where d.arm_id=a.arm_id)
          order by a.arm_id limit 10001`;
        requireCalendar(
          bound.length + Object.keys(expected).length <= 10_000,
          'task_limit',
        );
        for (const r of bound) {
          const a = arm(r);
          const [pr] = await tx<
            PeriodRow[]
          >`select * from allrice_native_calendar_periods where period_id=${a.periodId}`;
          requireCalendar(pr, 'period_missing');
          const c = control(await projection(tx, pr.control_id));
          const t = validateCalendarTask(
            c,
            period(pr),
            a,
            a.taskSnapshot,
            options.decodeTask,
          );
          requireCalendar(
            !Object.hasOwn(expected, t.record.id),
            'task_conflict',
          );
          expected[t.record.id] = t;
        }
        const prototype =
          input.taskRecords && Object.getPrototypeOf(input.taskRecords);
        requireCalendar(
          input.taskRecords &&
            !Array.isArray(input.taskRecords) &&
            (prototype === null || prototype === Object.prototype),
          'task_set_unproved',
        );
        const descriptors = Object.getOwnPropertyDescriptors(input.taskRecords);
        requireCalendar(
          Reflect.ownKeys(input.taskRecords).length ===
            Object.keys(descriptors).length &&
            Object.values(descriptors).every(
              (d) => 'value' in d && d.enumerable,
            ),
          'task_set_unproved',
        );
        const observed = Object.fromEntries(
          Object.entries(descriptors).map(([id, descriptor]) => [
            id,
            descriptor.value,
          ]),
        );
        nativeOnceDigest(observed);
        requireCalendar(
          isDeepStrictEqual(observed, expected),
          'task_set_unproved',
        );
        let proof: NativeCalendarArm['absenceProof'];
        if (aa.status === 'prepared')
          proof = {
            kind: 'never_started',
            taskSetDigest: nativeOnceDigest(expected),
          };
        else {
          const old = aa.createWriter;
          requireCalendar(
            old && old.partitionId === partitionId && w.epoch > old.epoch,
            'generation_not_fenced',
          );
          const [closed] = await tx<
            {
              proof: {
                kind: string;
                partitionId: string;
                ownerId: string;
                epoch: number;
                tokenDigest: string;
              };
            }[]
          >`
            select proof from allrice_native_once_close_proofs where partition_id=${partitionId} and epoch=${old.epoch}`;
          requireCalendar(
            closed &&
              ['public_host_backend_drained', 'verified_process_exit'].includes(
                closed.proof.kind,
              ) &&
              closed.proof.partitionId === partitionId &&
              closed.proof.ownerId === old.ownerId &&
              closed.proof.epoch === old.epoch &&
              closed.proof.tokenDigest === old.tokenDigest,
            'generation_not_fenced',
          );
          proof = {
            kind: 'fenced_generation',
            closedWriter: old,
            closeProofDigest: nativeOnceDigest(closed.proof),
            taskSetDigest: nativeOnceDigest(expected),
          };
        }
        const updatedA =
          await tx`update allrice_native_calendar_arms set status='absent',absence_proof=${json(tx, proof)},
          snapshot_version=snapshot_version+1,transition_writer=${json(tx, calendarWriterIdentity(w))}
          where arm_id=${aa.armId} and snapshot_version=${aa.snapshotVersion} and native_task_id is null returning arm_id`;
        const updatedP =
          await tx`update allrice_native_calendar_periods set state='recovery_required',version=version+1
          where period_id=${pp.periodId} and current_arm_id=${aa.armId} and version=${pp.version} returning period_id`;
        requireCalendar(
          updatedA.length === 1 && updatedP.length === 1,
          'snapshot_cas',
        );
        return {
          period: {
            ...pp,
            state: 'recovery_required' as const,
            version: pp.version + 1,
          },
          arm: NativeCalendarArmSchema.parse({
            ...aa,
            status: 'absent',
            absenceProof: proof,
            snapshotVersion: aa.snapshotVersion + 1,
          }),
        };
      });
    },
    async prepareCalendarArm(
      w: NativeOnceWriter,
      input: Parameters<typeof prepareCalendarArmInTransaction>[2],
    ) {
      requireEnabled();
      return base.bounded((tx) =>
        prepareCalendarArmInTransaction(tx, w, input),
      );
    },
    commitMutation,
    async readExactCommit(
      w: NativeOnceWriter,
      write: NativeCalendarWrite,
    ): Promise<'committed' | 'absent' | 'unknown'> {
      if (!enabled()) return 'unknown';
      try {
        return await base.bounded(
          (tx) => exact(tx, structuredClone(w), structuredClone(write)),
          true,
        );
      } catch {
        return 'unknown';
      }
    },
    async readExactCalendarArm(
      armId: string,
      requestDigest: string,
    ): Promise<NativeCalendarArmRead> {
      if (!enabled()) return { state: 'unknown' };
      try {
        return await base.bounded<NativeCalendarArmRead>(async (tx) => {
          const [r] = await tx<
            ArmRow[]
          >`select * from allrice_native_calendar_arms where arm_id=${armId}`;
          requireCalendar(r, 'arm_missing');
          const aa = arm(r);
          const [pr] = await tx<
            PeriodRow[]
          >`select * from allrice_native_calendar_periods
            where period_id=${aa.periodId} and partition_id=${partitionId}`;
          requireCalendar(
            pr && aa.requestDigest === requestDigest,
            'exact_conflict',
          );
          const pp = period(pr),
            c = control(await projection(tx, pr.control_id));
          validateCalendarBinding(c, pp, aa);
          if (aa.nativeTaskId !== null) {
            const bound = await journalRow(tx, aa.bindWriteId!);
            const last = await journalRow(tx, aa.lastWriteId!);
            requireCalendar(bound && last, 'exact_conflict');
            await verifyJournal(tx, bound);
            await verifyJournal(tx, last);
            const first = bound.journal.calendarLinks[0]?.arm;
            requireCalendar(
              first &&
                first.bindWriteId === bound.write_id &&
                first.lastWriteId === bound.write_id &&
                first.status === 'bound' &&
                first.nativeTaskId === aa.nativeTaskId &&
                isDeepStrictEqual(last.journal.calendarLinks[0]?.arm, aa) &&
                isDeepStrictEqual(last.journal.calendarLinks[0]?.period, pp),
              'exact_conflict',
            );
            const fullTask = validateCalendarTask(
              c,
              pp,
              aa,
              aa.taskSnapshot,
              options.decodeTask,
            );
            if (fullTask.lastDelivery) {
              const [o] = await tx<
                { payload: { receipt: unknown }; payload_digest: string }[]
              >`
                select payload,payload_digest from allrice_native_recurring_occurrences
                where calendar_period_id=${pp.periodId} and calendar_arm_id=${aa.armId}`;
              requireCalendar(
                o &&
                  nativeOnceDigest(o.payload) === o.payload_digest &&
                  isDeepStrictEqual(
                    o.payload.receipt,
                    fullTask.deliveryHistory?.records[0] ??
                      fullTask.lastDelivery,
                  ),
                'receipt_missing',
              );
            }
            return {
              state: 'bound',
              period: pp,
              arm: aa,
              fullTask,
              bindWrite: bound.journal.write,
              digests: {
                bindTaskDigest: bound.journal.calendarLinks[0]!.taskDigest,
                taskDigest: last.journal.calendarLinks[0]!.taskDigest,
                periodDigest: last.journal.calendarLinks[0]!.periodDigest,
                armDigest: last.journal.calendarLinks[0]!.armDigest,
              },
              lastWrite: last.journal.write,
            };
          }
          const [p] = await tx<
            { epoch: number | string; closed: boolean; reference: unknown }[]
          >`
            select epoch,closed,reference from allrice_native_once_partitions where partition_id=${partitionId}`;
          requireCalendar(
            p && isDeepStrictEqual(p.reference, reference),
            'reference_changed',
          );
          return {
            state: 'absent',
            period: pp,
            arm: aa,
            generationFence: {
              canCreate: false,
              currentEpoch: Number(p.epoch),
              closed: p.closed,
              createWriter: aa.createWriter,
              absenceProved: aa.status === 'absent' && aa.absenceProof !== null,
            },
          };
        }, true);
      } catch {
        return { state: 'unknown' };
      }
    },
  };
}
