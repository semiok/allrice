import { isDeepStrictEqual } from 'node:util';
import type { TransactionSql } from 'postgres';
import {
  createNativeCalendarSqlStore,
  type NativeCalendarSqlOptions,
} from './native-schedule-calendar-sql.ts';
import type { NativeCalendarWrite } from './native-schedule-calendar-state.ts';
import {
  loadNativeRecurringPartitionRows,
  type NativeRecurringPartitionControl,
} from './native-schedule-recurring-loader.ts';
import {
  createNativeScheduleControlSqlStore,
  NativeOnceSqlError,
  type NativeScheduleControlSqlOptions,
} from './native-schedule-control-sql.ts';
import {
  nativeOnceDigest,
  type NativeOnceWriter,
} from './native-schedule-once-state.ts';
import {
  NativeRecurringControlSchema,
  NativeRecurringRevisionSchema,
  NativeRecurringStateError,
  prepareNativeRecurringMutation,
  recurringControlIdentity,
  validateRecurringTask,
  type NativeRecurringControl,
  type NativeRecurringRevision,
  type NativeRecurringTask,
  type NativeRecurringSnapshot,
  type NativeRecurringWrite,
  type NativeRecurringAdmission,
} from './native-schedule-recurring-state.ts';

export type NativeRecurringSqlOptions = Omit<
  NativeScheduleControlSqlOptions<NativeRecurringPartitionControl>,
  'loadControls'
> & {
  /** Explicit dormant-protocol opt-in only. Current fixed Workers omit this.
   * Calendar parents still have their own independent loader and validator. */
  calendar?: Pick<NativeCalendarSqlOptions, 'lockAdmission'> & {
    enabled: true;
  };
  decodeTask: (raw: unknown) => NativeRecurringTask;
  lockAdmission: (
    tx: TransactionSql,
    controls: readonly NativeRecurringControl[],
  ) => Promise<ReadonlyMap<string, NativeRecurringAdmission>>;
};
type Row = {
  control_id: string;
  immutable_identity: ReturnType<typeof recurringControlIdentity>;
  snapshot: NativeRecurringSnapshot;
  snapshot_version: number | string;
};
const json = (tx: TransactionSql, v: unknown) =>
  tx.json(JSON.parse(JSON.stringify(v)));
function deny(code: string): never {
  throw new NativeRecurringStateError(code);
}

/** Recurring-only document/receipt mapping. Leases, workspace persistence and
 * explicit close proofs are the same implementation used by once-v1. */
export function createNativeRecurringSqlStore(
  options: NativeRecurringSqlOptions,
) {
  if (
    options.partitionId !== 'allrice-recurring-v1' ||
    options.reference.profileId !== 'allrice-recurring-control-v1'
  )
    deny('configuration_invalid');
  const partitionId = options.partitionId,
    reference = structuredClone(options.reference);
  async function controls(tx: TransactionSql) {
    return loadNativeRecurringPartitionRows(
      tx,
      reference,
      options.calendar?.enabled === true,
    );
  }
  const base =
    createNativeScheduleControlSqlStore<NativeRecurringPartitionControl>({
      ...options,
      loadControls: async (tx) =>
        (await controls(tx)).map((r) => structuredClone(r.snapshot.control)),
    });
  const calendar =
    options.calendar?.enabled === true
      ? createNativeCalendarSqlStore({
          ...options,
          ...options.calendar,
          sharedBase: base,
        })
      : null;
  async function versions(tx: TransactionSql, c: NativeRecurringControl) {
    const ids = [
      ...new Set(
        [c.revision, c.appliedRevision].filter((v): v is number => v !== null),
      ),
    ];
    const rows = await tx<
      { revision: number; configuration: NativeRecurringRevision }[]
    >`
      select revision,configuration from allrice_native_recurring_versions where automation_id=${c.automationId} and revision in ${tx(ids)}`;
    const map = new Map(
      rows.map((r) => [
        Number(r.revision),
        NativeRecurringRevisionSchema.parse(r.configuration),
      ]),
    );
    if (
      map.size !== ids.length ||
      rows.some((r) => Number(r.revision) !== r.configuration.revision)
    )
      deny('version_missing');
    return map;
  }
  async function exact(
    tx: TransactionSql,
    writer: NativeOnceWriter,
    write: NativeRecurringWrite,
  ): Promise<'committed' | 'absent' | 'unknown'> {
    if (
      writer.partitionId !== partitionId ||
      write.digest !== nativeOnceDigest(write.mutation)
    )
      return 'unknown';
    const [r] = await tx<
      {
        control_id: string;
        writer_owner_id: string;
        writer_epoch: number;
        writer_token_digest: string;
        reference: unknown;
        write_digest: string;
        mutation: unknown;
        journal: ReturnType<typeof prepareNativeRecurringMutation>['journal'];
        after_snapshot: NativeRecurringSnapshot;
        after_digest: string;
      }[]
    >`
      select * from allrice_native_recurring_journal where partition_id=${partitionId} and write_id=${write.writeId}`;
    if (!r) return 'absent';
    const j = r.journal;
    if (
      r.control_id !== write.mutation.controlId ||
      r.writer_owner_id !== writer.ownerId ||
      Number(r.writer_epoch) !== writer.epoch ||
      r.writer_token_digest !== nativeOnceDigest(writer.token) ||
      r.write_digest !== write.digest ||
      !isDeepStrictEqual(r.reference, reference) ||
      !isDeepStrictEqual(r.mutation, write.mutation) ||
      !isDeepStrictEqual(j.write, write) ||
      !isDeepStrictEqual(j.reference, reference) ||
      !isDeepStrictEqual(j.writer, {
        partitionId,
        ownerId: writer.ownerId,
        epoch: writer.epoch,
        tokenDigest: nativeOnceDigest(writer.token),
      }) ||
      j.afterDigest !== r.after_digest ||
      r.after_digest !== nativeOnceDigest(r.after_snapshot) ||
      !/^sha256:[a-f0-9]{64}$/.test(j.beforeDigest)
    )
      return 'unknown';
    const [c] = await tx<
      { immutable_identity: unknown }[]
    >`select immutable_identity from allrice_native_recurring_controls
      where partition_id=${partitionId} and control_id=${r.control_id}`;
    const [p] = await tx<
      { reference: unknown }[]
    >`select reference from allrice_native_once_partitions where partition_id=${partitionId}`;
    if (
      !c ||
      !p ||
      !isDeepStrictEqual(p.reference, reference) ||
      !isDeepStrictEqual(c.immutable_identity, j.identity) ||
      !isDeepStrictEqual(
        recurringControlIdentity(
          NativeRecurringControlSchema.parse(r.after_snapshot.control),
        ),
        j.identity,
      )
    )
      return 'unknown';
    if (
      !Array.isArray(j.receiptLinks) ||
      j.receiptLinks.length > 200 ||
      new Set(j.receiptLinks.map((l) => l.id)).size !== j.receiptLinks.length
    )
      return 'unknown';
    for (const link of j.receiptLinks) {
      const [o] = await tx<
        { occurrence_key: string; payload_digest: string; payload: unknown }[]
      >`select occurrence_key,payload_digest,payload
        from allrice_native_recurring_occurrences where partition_id=${partitionId} and control_id=${r.control_id} and occurrence_id=${link.id}`;
      if (
        !o ||
        o.occurrence_key !== link.key ||
        o.payload_digest !== link.payloadDigest ||
        nativeOnceDigest(o.payload) !== link.payloadDigest
      )
        return 'unknown';
    }
    return 'committed';
  }
  async function commitMutation(
    given: NativeOnceWriter,
    raw: NativeRecurringWrite | NativeCalendarWrite,
  ): Promise<'committed' | 'rejected'> {
    if (raw.mutation.kind === 'calendar')
      return calendar
        ? calendar.commitMutation(given, raw as NativeCalendarWrite)
        : 'rejected';
    const writer = structuredClone(given),
      write = structuredClone(raw as NativeRecurringWrite);
    try {
      nativeOnceDigest(write);
      if (
        !write.writeId ||
        write.writeId.length > 512 ||
        write.digest !== nativeOnceDigest(write.mutation)
      )
        deny('write_invalid');
      return await base.bounded<'committed' | 'rejected'>(async (tx) => {
        const prior = await exact(tx, writer, write);
        if (prior === 'committed') return prior;
        if (prior !== 'absent') deny('exact_conflict');
        // Only an immutable projection is read before current business locks.
        const [projected] = await tx<
          Row[]
        >`select control_id,immutable_identity,snapshot,snapshot_version from allrice_native_recurring_controls
          where partition_id=${partitionId} and control_id=${write.mutation.controlId}`;
        if (!projected) deny('control_missing');
        const admission = await options.lockAdmission(tx, [
          NativeRecurringControlSchema.parse(projected.snapshot.control),
        ]);
        const p = await base.partition(tx, 'update');
        await base.requireActive(tx, p, writer);
        const [row] = await tx<
          Row[]
        >`select control_id,immutable_identity,snapshot,snapshot_version from allrice_native_recurring_controls
          where partition_id=${partitionId} and control_id=${write.mutation.controlId} for update`;
        const recheck = await exact(tx, writer, write);
        if (recheck === 'committed') return recheck;
        if (
          recheck !== 'absent' ||
          !row ||
          !isDeepStrictEqual(
            row.immutable_identity,
            projected.immutable_identity,
          )
        )
          deny('control_changed');
        const frozenVersions = await versions(tx, row.snapshot.control);
        const planned = prepareNativeRecurringMutation({
          readiness: base.readiness(p!),
          reference,
          writerRow: base.asWriterRow(p!),
          writer,
          dbNowMs: await base.requireActive(tx, p, writer),
          before: row.snapshot,
          write,
          revisions: frozenVersions,
          decodeTask: options.decodeTask,
          admission: admission.get(row.control_id),
        });
        for (const o of planned.occurrences) {
          const [old] = await tx<
            {
              occurrence_key: string;
              payload_digest: string;
              payload: unknown;
              client_message_id: string;
            }[]
          >`
            select occurrence_key,payload_digest,payload,client_message_id from allrice_native_recurring_occurrences where occurrence_id=${o.id}`;
          if (old) {
            if (
              old.occurrence_key !== o.key ||
              old.payload_digest !== o.payloadDigest ||
              old.client_message_id !== o.clientMessageId ||
              !isDeepStrictEqual(old.payload, o.payload)
            )
              deny('occurrence_conflict');
          } else
            await tx`insert into allrice_native_recurring_occurrences
            (occurrence_id,partition_id,control_id,automation_id,revision,scheduled_at,occurrence_key,client_message_id,payload_digest,payload,outbox_state,outbox_reason)
            values(${o.id},${partitionId},${row.control_id},${planned.after.control.automationId},${o.payload.revision.revision},
              ${o.payload.receipt.scheduledAt}::timestamptz,${o.key},${o.clientMessageId},${o.payloadDigest},${json(tx, o.payload)},${o.state},${o.reason})`;
        }
        const updated =
          await tx`update allrice_native_recurring_controls set snapshot=${json(tx, planned.after)},native_task_id=${planned.after.control.nativeTaskId},
          snapshot_version=snapshot_version+1 where partition_id=${partitionId} and control_id=${row.control_id} and snapshot_version=${Number(row.snapshot_version)} returning control_id`;
        if (updated.length !== 1) deny('snapshot_cas');
        await tx`insert into allrice_native_recurring_journal
          (partition_id,write_id,control_id,writer_owner_id,writer_epoch,writer_token_digest,reference,write_digest,mutation,journal,after_snapshot,after_digest)
          values(${partitionId},${write.writeId},${row.control_id},${writer.ownerId},${writer.epoch},${nativeOnceDigest(writer.token)},
            ${json(tx, reference)},${write.digest},${json(tx, write.mutation)},${json(tx, planned.journal)},${json(tx, planned.after)},${planned.journal.afterDigest})`;
        if (write.mutation.kind === 'confirm_command')
          await tx`update allrice_native_recurring_operations set status='applied',updated_at=clock_timestamp()
          where automation_id=${planned.after.control.automationId} and operation_id=${write.mutation.commandId} and status='pending'`;
        const task = planned.after.task as NativeRecurringTask | null;
        if (
          row.snapshot.task === null &&
          task &&
          'consumer' in planned.after.control.dispatch
        ) {
          const { recordQualityNativeClockHandoff } =
            await import('./platform-quality-native.ts');
          await recordQualityNativeClockHandoff(
            tx,
            planned.after.control,
            frozenVersions.get(planned.after.control.revision)!,
            task.record.scheduledAt,
          );
        }
        await tx`update allrice_automations set next_run_at=case when status='enabled' and deleted_at is null and ${planned.after.control.command.status === 'confirmed'}
          then ${task?.record.scheduledAt ?? null}::timestamptz else null end where id=${planned.after.control.automationId}`;
        await base.requireActive(tx, p, writer);
        return 'committed';
      });
    } catch (error) {
      if (
        error instanceof NativeRecurringStateError ||
        error instanceof NativeOnceSqlError ||
        (error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'P1920')
      )
        return 'rejected';
      // A SQL/COMMIT/network error remains unknown. The controller performs one
      // exact primary readback for this same write rather than resubmitting it.
      throw error;
    }
  }
  return {
    acquireWriter: base.acquireWriter,
    takeoverRefusal: base.takeoverRefusal,
    renewWriter: base.renewWriter,
    assertWriter: base.assertWriter,
    loadControls: base.loadControls,
    loadWorkspaceUnit: base.loadWorkspaceUnit,
    commitWorkspaceWrite: base.commitWorkspaceWrite,
    releaseClosedWriter: base.releaseClosedWriter,
    async loadTaskRecords(writer: NativeOnceWriter) {
      return base.bounded(async (tx) => {
        const p = await base.partition(tx, 'share');
        await base.requireActive(tx, p, writer);
        const records: Record<string, unknown> = Object.create(null);
        for (const row of await controls(tx))
          if (row.kind === 'recurring' && row.snapshot.task !== null) {
            const task = validateRecurringTask(
              row.snapshot.control,
              row.snapshot.task,
              options.decodeTask,
            );
            // Retained receipts must already have their exact SQL evidence. A
            // load never reconstructs or dispatches missing deliveries.
            const history =
              task.deliveryHistory?.records ??
              (task.lastDelivery ? [task.lastDelivery] : []);
            for (const receipt of history) {
              const [o] = await tx<
                { payload: { receipt: unknown }; payload_digest: string }[]
              >`select payload,payload_digest from allrice_native_recurring_occurrences
              where partition_id=${partitionId} and control_id=${row.control_id} and payload->>'nativeTaskId'=${task.record.id}
                and payload->'receipt'->>'scheduledAt'=${receipt.scheduledAt} and payload->'receipt'->>'messageId'=${receipt.messageId}`;
              if (
                !o ||
                !isDeepStrictEqual(o.payload.receipt, receipt) ||
                nativeOnceDigest(o.payload) !== o.payload_digest
              )
                deny('receipt_missing');
            }
            records[task.record.id] = structuredClone(task);
          }
        if (calendar)
          for (const [id, task] of Object.entries(
            await calendar.loadTaskRecordsInTransaction(tx),
          )) {
            if (Object.hasOwn(records, id)) deny('task_conflict');
            records[id] = structuredClone(task);
          }
        if (Object.keys(records).length > 10_000) deny('task_limit');
        await base.requireActive(tx, p, writer);
        return records;
      });
    },
    commitMutation,
    /** Format operations only. Lifecycle remains the common base above. */
    calendar: calendar && {
      withTransaction: calendar.withTransaction,
      commitMutationInTransaction: calendar.commitMutationInTransaction,
      loadCalendarState: calendar.loadCalendarState,
      readExactCalendarRetirement: calendar.readExactCalendarRetirement,
      initializeControlInTransaction: calendar.initializeControlInTransaction,
      prepareCalendarPeriodInTransaction:
        calendar.prepareCalendarPeriodInTransaction,
      prepareCalendarArmInTransaction: calendar.prepareCalendarArmInTransaction,
      beginCalendarArmCreate: calendar.beginCalendarArmCreate,
      confirmCalendarArmAbsent: calendar.confirmCalendarArmAbsent,
      prepareCalendarArm: calendar.prepareCalendarArm,
      readExactCalendarArm: calendar.readExactCalendarArm,
    },
    async readExactCommit(
      writer: NativeOnceWriter,
      write: NativeRecurringWrite | NativeCalendarWrite,
    ): Promise<'committed' | 'absent' | 'unknown'> {
      if (write.mutation.kind === 'calendar')
        return calendar
          ? calendar.readExactCommit(writer, write as NativeCalendarWrite)
          : 'unknown';
      try {
        return await base.bounded(
          (tx) =>
            exact(
              tx,
              structuredClone(writer),
              structuredClone(write as NativeRecurringWrite),
            ),
          true,
        );
      } catch {
        return 'unknown';
      }
    },
  };
}
