import { isDeepStrictEqual } from 'node:util';
import type { TransactionSql } from 'postgres';
import {
  NativeOnceStateError,
  nativeOnceDigest,
  validNativeOnceDispatch,
  prepareNativeOnceMutation,
  verifyExactNativeOnceCommit,
  type NativeOnceAdmissionFacts,
  type NativeOnceCommitEvidence,
  type NativeOnceControl,
  type NativeOnceJournal,
  type NativeOnceOccurrence,
  type NativeOnceReference,
  type NativeOnceSnapshot,
  type NativeOnceTask,
  type NativeOnceWrite,
  type NativeOnceWriter,
} from './native-schedule-once-state.ts';

import {
  createNativeScheduleControlSqlStore,
  NativeOnceSqlError,
  type NativeScheduleControlSqlOptions,
} from './native-schedule-control-sql.ts';
export {
  NativeOnceSqlError,
  type NativeOnceClosedProof,
} from './native-schedule-control-sql.ts';
function reject(code: string): never {
  throw new NativeOnceSqlError(code);
}
export type NativeOnceLockedAdmission = Omit<
  NativeOnceAdmissionFacts,
  'checkedAtMs'
>;
export interface NativeOnceSqlOptions extends Omit<
  NativeScheduleControlSqlOptions<NativeOnceControl>,
  'loadControls'
> {
  /** EXACT approved public Schedule valueSchema.parse; never a projection. */
  decodeTask: (value: unknown) => NativeOnceTask;
  /** MUST lock real current identity -> cloud -> automation/revision -> exact
   * assignment/instance/business Session in product lock order, in this tx.
   * Immutable projections are supplied before partition/control locks so that
   * this adapter never introduces partition -> tenant lock inversion.
   * SQL only: no network, model, Host, or human waits. Missing facts block
   * receipt outbox; they do not fabricate current authorization. */
  lockAdmission: (
    tx: TransactionSql,
    controls: readonly NativeOnceControl[],
  ) => Promise<ReadonlyMap<string, NativeOnceLockedAdmission>>;
}
type ControlRow = {
  control_id: string;
  immutable_control: NativeOnceControl;
  snapshot: NativeOnceSnapshot;
  snapshot_version: string | number;
};
type OccurrenceRow = {
  occurrence_id: string;
  occurrence_key: string;
  payload: NativeOnceOccurrence['payload'];
  payload_digest: string;
  outbox_state: NativeOnceOccurrence['outbox']['state'];
  outbox_reason: string | null;
};
type JournalRow = {
  entry_kind: 'control' | 'workspace';
  control_id: string;
  writer_owner_id: string;
  writer_epoch: string | number;
  writer_token_digest: string;
  reference: NativeOnceReference;
  write_digest: string;
  mutation: NativeOnceWrite['mutation'];
  journal: NativeOnceJournal;
  after_snapshot: NativeOnceSnapshot;
  after_digest: string;
  occurrence_id: string | null;
};
function sqlJson(tx: TransactionSql, value: unknown) {
  // Validate strict JSON before handing postgres.js a structural JSON value.
  nativeOnceDigest(value);
  return tx.json(JSON.parse(JSON.stringify(value)));
}
const positive = (v: number, max: number) =>
  Number.isSafeInteger(v) && v > 0 && v <= max;
const id = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 512;
const frozen = (c: NativeOnceControl) => {
  const snapshot: Partial<NativeOnceControl> = { ...c };
  delete snapshot.sessionState;
  delete snapshot.nativeTaskId;
  delete snapshot.taskDeleted;
  delete snapshot.command;
  return snapshot;
};
const occurrence = (r: OccurrenceRow): NativeOnceOccurrence => ({
  id: r.occurrence_id,
  key: r.occurrence_key,
  payload: r.payload,
  payloadDigest: r.payload_digest,
  outbox: {
    occurrenceId: r.occurrence_id,
    payloadDigest: r.payload_digest,
    state: r.outbox_state,
    reason: r.outbox_reason,
  },
});

/** Server-only SQL ports. Caller must separately prove product activation.
 * Every success is returned only after postgres.js BEGIN callback COMMIT ACK.
 * Validation rejection is returned only after BEGIN callback rollback finishes;
 * SQL/COMMIT/network errors propagate and require exact primary readback. */
export function createNativeOnceSqlStore(options: NativeOnceSqlOptions) {
  const reference = structuredClone(options.reference);
  const partitionId = options.partitionId;
  const common = createNativeScheduleControlSqlStore<NativeOnceControl>({
    db: options.db,
    partitionId,
    ownerId: options.ownerId,
    reference,
    ttlMs: options.ttlMs,
    lockTimeoutMs: options.lockTimeoutMs,
    statementTimeoutMs: options.statementTimeoutMs,
    // Preserve the original options' live readiness/proof callbacks.
    readiness: () => options.readiness?.() ?? {},
    proveClosed: (writer) => options.proveClosed(writer),
    loadControls: async (tx) =>
      (await controls(tx)).map((row) => row.snapshot.control),
  });
  if (
    typeof options.decodeTask !== 'function' ||
    typeof options.lockAdmission !== 'function' ||
    typeof options.proveClosed !== 'function'
  )
    reject('configuration_invalid');
  const { bounded, partition, requireActive, readiness, asWriterRow } = common;
  async function controls(tx: TransactionSql) {
    const rows = await tx<
      ControlRow[]
    >`select control_id,immutable_control,snapshot,snapshot_version
      from allrice_native_once_controls where partition_id=${partitionId}
      order by control_id limit 10001`;
    if (rows.length > 10_000) reject('control_limit');
    const sessions = new Set<string>(),
      revisions = new Set<string>(),
      tasks = new Set<string>();
    for (const r of rows) {
      const c = r.snapshot?.control;
      nativeOnceDigest(r.snapshot);
      if (
        !c ||
        c.partitionId !== partitionId ||
        c.controlId !== r.control_id ||
        !isDeepStrictEqual(frozen(c), frozen(r.immutable_control)) ||
        !Number.isSafeInteger(c.revision) ||
        c.revision < 1 ||
        ![
          c.partitionId,
          c.controlId,
          c.organizationId,
          c.workspaceId,
          c.ownerId,
          c.automationId,
          c.controlSessionId,
          c.at,
        ].every(id) ||
        !validNativeOnceDispatch(c.dispatch) ||
        !['reserved', 'initializing', 'ready'].includes(c.sessionState) ||
        !['create', 'delete'].includes(c.command.kind) ||
        !['pending', 'confirmed', 'blocked'].includes(c.command.status) ||
        !id(c.command.id) ||
        typeof c.taskDeleted !== 'boolean' ||
        !Number.isFinite(Date.parse(c.at)) ||
        new Date(c.at).toISOString() !== c.at ||
        sessions.has(c.controlSessionId) ||
        revisions.has(JSON.stringify([c.automationId, c.revision])) ||
        (c.nativeTaskId !== null &&
          (!id(c.nativeTaskId) ||
            tasks.has(c.nativeTaskId) ||
            c.sessionState !== 'ready')) ||
        (c.nativeTaskId !== null &&
          !c.taskDeleted &&
          r.snapshot.task === null) ||
        (c.nativeTaskId === null && r.snapshot.task !== null) ||
        (c.taskDeleted && r.snapshot.task !== null)
      )
        reject('control_invalid');
      sessions.add(c.controlSessionId);
      revisions.add(JSON.stringify([c.automationId, c.revision]));
      if (c.nativeTaskId !== null) tasks.add(c.nativeTaskId);
    }
    return rows;
  }
  async function findOccurrence(tx: TransactionSql, c: NativeOnceControl) {
    const rows = await tx<
      OccurrenceRow[]
    >`select * from allrice_native_once_occurrences
      where occurrence_id=${c.dispatch.occurrenceId}
        or (automation_id=${c.automationId} and revision=${c.revision} and scheduled_at=${c.at})`;
    if (rows.length > 1) reject('occurrence_conflict');
    return rows[0] ? occurrence(rows[0]) : undefined;
  }
  async function evidence(
    tx: TransactionSql,
    w: NativeOnceWriter,
    write: NativeOnceWrite,
  ): Promise<NativeOnceCommitEvidence> {
    if (w.partitionId !== partitionId) return { kind: 'unknown' };
    const [r] = await tx<JournalRow[]>`select * from allrice_native_once_journal
      where partition_id=${partitionId} and write_id=${write.writeId}`;
    if (!r) return { kind: 'absent', partitionId, writeId: write.writeId };
    if (r.entry_kind !== 'control' || !r.control_id) return { kind: 'unknown' };
    const [retained] = await tx<{ reference: NativeOnceReference }[]>`
      select reference from allrice_native_once_partitions where partition_id=${partitionId}`;
    if (
      !retained ||
      !isDeepStrictEqual(retained.reference, r.reference) ||
      !isDeepStrictEqual(reference, r.reference)
    )
      return { kind: 'unknown' };
    const j = r.journal;
    if (
      r.writer_owner_id !== j.writer.ownerId ||
      Number(r.writer_epoch) !== j.writer.epoch ||
      r.writer_token_digest !== j.writer.tokenDigest ||
      r.write_digest !== j.write.digest ||
      !isDeepStrictEqual(r.mutation, j.write.mutation) ||
      r.after_digest !== j.afterDigest ||
      r.control_id !== write.mutation.controlId ||
      r.occurrence_id !== (j.receiptLink?.id ?? null)
    )
      return { kind: 'unknown' };
    const [c] = await tx<
      ControlRow[]
    >`select immutable_control from allrice_native_once_controls
      where partition_id=${partitionId} and control_id=${r.control_id}`;
    let o: NativeOnceOccurrence | null = null;
    if (r.occurrence_id) {
      const [found] = await tx<
        OccurrenceRow[]
      >`select * from allrice_native_once_occurrences
        where partition_id=${partitionId} and control_id=${r.control_id} and occurrence_id=${r.occurrence_id}`;
      if (!found) return { kind: 'unknown' };
      o = occurrence(found);
    }
    return c
      ? {
          kind: 'found',
          journal: j,
          committedSnapshot: r.after_snapshot,
          immutableControl: c.immutable_control,
          reference: r.reference,
          occurrence: o,
        }
      : { kind: 'unknown' };
  }
  const exact = async (
    tx: TransactionSql,
    w: NativeOnceWriter,
    write: NativeOnceWrite,
  ) => verifyExactNativeOnceCommit(w, write, await evidence(tx, w, write));
  async function commitBatch(
    given: NativeOnceWriter,
    input: readonly NativeOnceWrite[],
  ): Promise<'committed' | 'rejected'> {
    try {
      const w = structuredClone(given);
      const writes = structuredClone(input);
      if (
        w.partitionId !== partitionId ||
        !positive(writes.length, 256) ||
        new Set(writes.map((x) => x.writeId)).size !== writes.length
      )
        reject('write_invalid');
      for (const write of writes) {
        nativeOnceDigest(write);
        if (
          !id(write.writeId) ||
          write.digest !== nativeOnceDigest(write.mutation)
        )
          reject('write_invalid');
      }
      return await bounded<'committed' | 'rejected'>(async (tx) => {
        const first = await Promise.all(
          writes.map((write) => exact(tx, w, write)),
        );
        if (first.some((x) => x === 'unknown')) reject('exact_conflict');
        if (first.every((x) => x === 'committed')) return 'committed';
        // Nonlocking immutable read only. Current tenant locks are taken first.
        const projected = await controls(tx);
        const needed = new Set(writes.map((x) => x.mutation.controlId));
        const selected = projected.filter((r) => needed.has(r.control_id));
        if (selected.length !== needed.size) reject('control_missing');
        const admission = await options.lockAdmission(
          tx,
          selected.map((r) => structuredClone(r.immutable_control)),
        );
        const p = await partition(tx, 'update');
        await requireActive(tx, p, w);
        const locked = await tx<
          ControlRow[]
        >`select control_id,immutable_control,snapshot,snapshot_version
          from allrice_native_once_controls where partition_id=${partitionId} and control_id in ${tx([...needed].sort())}
          order by control_id for update`;
        const byId = new Map(locked.map((r) => [r.control_id, r]));
        for (const write of writes) {
          const already = await exact(tx, w, write);
          if (already === 'committed') continue;
          if (already !== 'absent') reject('exact_conflict');
          const row = byId.get(write.mutation.controlId);
          const projection = selected.find(
            (r) => r.control_id === row?.control_id,
          );
          if (
            !row ||
            !projection ||
            !isDeepStrictEqual(
              row.immutable_control,
              projection.immutable_control,
            )
          )
            reject('control_changed');
          const now = await requireActive(tx, p, w);
          const current = admission.get(row.control_id);
          const planned = prepareNativeOnceMutation({
            readiness: readiness(p!),
            writerRow: asWriterRow(p!),
            writer: w,
            dbNowMs: now,
            before: row.snapshot,
            write,
            decodeTask: options.decodeTask,
            admission: current
              ? { ...structuredClone(current), checkedAtMs: now }
              : undefined,
            existingOccurrence: await findOccurrence(tx, row.snapshot.control),
          });
          const o = planned.occurrence;
          if (o) {
            const old = await findOccurrence(tx, row.snapshot.control);
            if (!old)
              await tx`insert into allrice_native_once_occurrences
              (occurrence_id,partition_id,control_id,automation_id,revision,scheduled_at,occurrence_key,payload_digest,payload,outbox_state,outbox_reason)
              values (${o.id},${partitionId},${row.control_id},${planned.after.control.automationId},${planned.after.control.revision},${planned.after.control.at},
                ${o.key},${o.payloadDigest},${sqlJson(tx, o.payload)},${o.outbox.state},${o.outbox.reason})`;
            else if (!isDeepStrictEqual(old, o)) reject('occurrence_conflict');
          }
          const updated =
            await tx`update allrice_native_once_controls set snapshot=${sqlJson(tx, planned.after)},
            native_task_id=${planned.after.control.nativeTaskId},snapshot_version=snapshot_version+1
            where partition_id=${partitionId} and control_id=${row.control_id} and snapshot_version=${Number(row.snapshot_version)} returning control_id`;
          if (updated.length !== 1) reject('snapshot_cas');
          await tx`insert into allrice_native_once_journal
            (partition_id,write_id,control_id,writer_owner_id,writer_epoch,writer_token_digest,reference,write_digest,mutation,journal,after_snapshot,after_digest,occurrence_id)
            values (${partitionId},${write.writeId},${row.control_id},${w.ownerId},${w.epoch},${nativeOnceDigest(w.token)},
              ${sqlJson(tx, p!.reference)},${write.digest},${sqlJson(tx, write.mutation)},${sqlJson(tx, planned.journal)},
              ${sqlJson(tx, planned.after)},${planned.journal.afterDigest},${o?.id ?? null})`;
          row.snapshot = planned.after;
          row.snapshot_version = Number(row.snapshot_version) + 1;
        }
        // Fresh wall time AFTER every lock wait and write; a failed fence rolls
        // back task, receipt, outbox, snapshots AND all batch journals together.
        await requireActive(tx, p, w);
        return 'committed';
      });
    } catch (error) {
      if (
        error instanceof NativeOnceStateError ||
        error instanceof NativeOnceSqlError ||
        (error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'P1920')
      )
        return 'rejected';
      throw error;
    }
  }

  return {
    loadWorkspaceUnit: common.loadWorkspaceUnit,
    commitWorkspaceWrite: common.commitWorkspaceWrite,
    acquireWriter: common.acquireWriter,
    takeoverRefusal: common.takeoverRefusal,
    renewWriter: common.renewWriter,
    assertWriter: common.assertWriter,
    loadControls: common.loadControls,
    async loadTaskRecords(given: NativeOnceWriter) {
      const w = structuredClone(given);
      return bounded(async (tx) => {
        const p = await partition(tx, 'share');
        const now = await requireActive(tx, p, w);
        const loaded = await controls(tx);
        const records: Record<string, unknown> = Object.create(null);
        for (const r of loaded)
          if (r.snapshot.task !== null) {
            // Reuse exact full-task/receipt checks. This is a pure validation plan,
            // not a synthetic persisted write and never an execution grant.
            prepareNativeOnceMutation({
              readiness: readiness(p!),
              writerRow: asWriterRow(p!),
              writer: w,
              dbNowMs: now,
              before: r.snapshot,
              write: {
                writeId: 'validation',
                mutation: {
                  kind: 'put_task',
                  controlId: r.control_id,
                  task: r.snapshot.task,
                },
                digest: nativeOnceDigest({
                  kind: 'put_task',
                  controlId: r.control_id,
                  task: r.snapshot.task,
                }),
              },
              decodeTask: options.decodeTask,
              existingOccurrence: await findOccurrence(tx, r.snapshot.control),
            });
            if (
              (r.snapshot.task as NativeOnceTask).lastDelivery &&
              !(await findOccurrence(tx, r.snapshot.control))
            )
              reject('occurrence_missing');
            records[r.snapshot.control.nativeTaskId!] = structuredClone(
              r.snapshot.task,
            );
          }
        await requireActive(tx, p, w);
        return records;
      });
    },
    commitMutation(w: NativeOnceWriter, write: NativeOnceWrite) {
      return commitBatch(w, [write]);
    },
    /** Optional internal atomic batch; current controller uses one mutation.
     * All writes share one transaction, tenant lock set and final fence. */
    commitMutationBatch: commitBatch,
    async readExactCommit(
      given: NativeOnceWriter,
      input: NativeOnceWrite,
    ): Promise<'committed' | 'absent' | 'unknown'> {
      try {
        const w = structuredClone(given),
          write = structuredClone(input);
        return await bounded<'committed' | 'absent' | 'unknown'>(async (tx) => {
          // Immutable journal/control identity plus immutable occurrence payload
          // make this one consistent historical proof even after current state
          // or outbox progress advances. No live fence or execution admission.
          return exact(tx, w, write);
        }, true);
      } catch {
        return 'unknown';
      }
    },
    releaseClosedWriter: common.releaseClosedWriter,
  };
}
