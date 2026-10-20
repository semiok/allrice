import {
  NativeOnceWorkspaceError,
  nativeOnceWorkspaceDigest,
  validateNativeOnceWorkspaceSnapshot,
  validateNativeOnceWorkspaceWrite,
  applyNativeOnceWorkspaceWrite,
  type NativeOnceWorkspaceSnapshot,
  type NativeOnceWorkspaceWrite,
  type NativeOnceWorkspaceScope,
} from './native-schedule-workspace-state.ts';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Sql, TransactionSql } from 'postgres';
import {
  NativeOnceStateError,
  nativeOnceDigest,
  nativeOnceReady,
  nativeOnceWriterRemaining,
  planNativeOnceAcquire,
  planNativeOnceClosed,
  planNativeOnceRenew,
  prepareNativeOnceMutation,
  verifyExactNativeOnceCommit,
  type NativeOnceAdmissionFacts,
  type NativeOnceCommitEvidence,
  type NativeOnceControl,
  type NativeOnceJournal,
  type NativeOnceOccurrence,
  type NativeOnceReadiness,
  type NativeOnceReference,
  type NativeOnceSnapshot,
  type NativeOnceTask,
  type NativeOnceWrite,
  type NativeOnceWriter,
  type NativeOnceWriterRow,
} from './native-schedule-once-state.ts';

/** Internal candidate, default off. No environment fallback, enrollment,
 * scanner change, business dispatch, Job lease, or shared package export. */
export class NativeOnceSqlError extends Error {
  constructor(readonly code: string) {
    super(`native_once_sql_${code}`);
  }
}
function reject(code: string): never {
  throw new NativeOnceSqlError(code);
}
export type NativeOnceLockedAdmission = Omit<
  NativeOnceAdmissionFacts,
  'checkedAtMs'
>;
export interface NativeOnceClosedProof {
  kind: 'public_host_backend_drained' | 'verified_process_exit';
  proofId: string;
  partitionId: string;
  ownerId: string;
  epoch: number;
  tokenDigest: string;
  /** Auditable public close/drain sequence or independent exit evidence.
   * A timeout, expired TTL, missing heartbeat or runtime loss is not evidence. */
  evidence: Record<string, unknown>;
}
export interface NativeOnceSqlOptions {
  /** Primary connection only; caller owns its lifetime. */
  db: Sql;
  partitionId: string;
  ownerId: string;
  reference: NativeOnceReference;
  ttlMs?: number;
  readiness?: () => NativeOnceReadiness;
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
  /** Caller must wire this to the completed exact Host/backend drain lifecycle
   * (or independently verified process exit). Null refuses release. */
  proveClosed: (
    writer: NativeOnceWriter,
  ) => Promise<NativeOnceClosedProof | null>;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
}
type Partition = {
  partition_id: string;
  owner_id: string | null;
  epoch: string | number;
  token_digest: string | null;
  expires_at_ms: number | null;
  closed: boolean;
  reference: NativeOnceReference;
  activation: NativeOnceReadiness;
  workspace_snapshot: NativeOnceWorkspaceSnapshot | null;
  close_proof: NativeOnceClosedProof | { kind: 'never_acquired' } | null;
};
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
type WorkspaceJournalRow = Omit<
  JournalRow,
  'control_id' | 'mutation' | 'journal' | 'after_snapshot'
> & {
  control_id: string | null;
  mutation: NativeOnceWorkspaceWrite['mutation'];
  after_snapshot: NativeOnceWorkspaceSnapshot;
  journal: {
    kind: 'workspace';
    unitVersion: 2;
    writer: {
      partitionId: string;
      ownerId: string;
      epoch: number;
      tokenDigest: string;
    };
    reference: NativeOnceReference;
    write: NativeOnceWorkspaceWrite;
    beforeRevision: number;
    afterRevision: number;
    beforeDigest: string;
    afterDigest: string;
  };
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
const asWriterRow = (p: Partition): NativeOnceWriterRow => ({
  partitionId: p.partition_id,
  ownerId: p.owner_id,
  epoch: Number(p.epoch),
  tokenDigest: p.token_digest,
  expiresAtMs: p.expires_at_ms,
  closed: p.closed,
  reference: p.reference,
});
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
  const { db } = options;
  const reference = structuredClone(options.reference);
  const ttl = options.ttlMs ?? 30_000;
  const lockTimeout = options.lockTimeoutMs ?? 500;
  const statementTimeout = options.statementTimeoutMs ?? 2_000;
  if (
    !id(options.partitionId) ||
    !id(options.ownerId) ||
    ![
      reference.artifactId,
      reference.profileId,
      reference.storageId,
      reference.stateRoot,
    ].every(id) ||
    Object.keys(reference).length !== 4 ||
    !positive(ttl, 300_000) ||
    !positive(lockTimeout, 5_000) ||
    !positive(statementTimeout, 10_000) ||
    typeof options.decodeTask !== 'function' ||
    typeof options.lockAdmission !== 'function' ||
    typeof options.proveClosed !== 'function'
  )
    reject('configuration_invalid');
  const partitionId = options.partitionId;
  const ownerId = options.ownerId;
  async function bounded<T>(
    fn: (tx: TransactionSql) => Promise<T>,
    repeatable = false,
  ): Promise<T> {
    const work = async (tx: TransactionSql) => {
      await tx`select set_config('lock_timeout', ${String(lockTimeout)}, true),
        set_config('statement_timeout', ${String(statementTimeout)}, true),
        set_config('idle_in_transaction_session_timeout', '10000', true)`;
      return fn(tx);
    };
    return (
      repeatable
        ? db.begin('isolation level repeatable read', work)
        : db.begin(work)
    ) as Promise<T>;
  }
  const dbNow = async (tx: TransactionSql) => {
    const [r] = await tx<{ now_ms: number }[]>`
      select floor(extract(epoch from clock_timestamp())*1000)::float8 now_ms`;
    return r!.now_ms;
  };
  async function partition(tx: TransactionSql, lock: 'share' | 'update') {
    const rows =
      lock === 'update'
        ? await tx<
            Partition[]
          >`select *,floor(extract(epoch from expires_at)*1000)::float8 expires_at_ms
          from allrice_native_once_partitions where partition_id=${partitionId} for update`
        : await tx<
            Partition[]
          >`select *,floor(extract(epoch from expires_at)*1000)::float8 expires_at_ms
          from allrice_native_once_partitions where partition_id=${partitionId} for share`;
    return rows[0];
  }
  const readiness = (p: Partition): NativeOnceReadiness => {
    const deployed = options.readiness?.() ?? {};
    return {
      enabled: deployed.enabled === true && p.activation.enabled === true,
      storageReady:
        deployed.storageReady === true && p.activation.storageReady === true,
      legacyClockExcluded:
        deployed.legacyClockExcluded === true &&
        p.activation.legacyClockExcluded === true,
      controlArtifactApproved:
        deployed.controlArtifactApproved === true &&
        p.activation.controlArtifactApproved === true,
    };
  };
  function active(p: Partition | undefined, w: NativeOnceWriter, now: number) {
    return (
      !!p &&
      w.partitionId === partitionId &&
      isDeepStrictEqual(p.reference, reference) &&
      nativeOnceReady(readiness(p)) &&
      nativeOnceWriterRemaining(asWriterRow(p), w, now) > 0
    );
  }
  async function requireActive(
    tx: TransactionSql,
    p: Partition | undefined,
    w: NativeOnceWriter,
  ) {
    const now = await dbNow(tx);
    if (!active(p, w, now)) reject('lease_lost');
    return now;
  }
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
        !Object.values(c.dispatch).every(id) ||
        !/^sha256:[a-f0-9]{64}$/.test(c.dispatch.reservationDigest) ||
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
  async function validClose(tx: TransactionSql, p: Partition) {
    const proof = p.close_proof;
    if (!p.closed || !proof) return false;
    if (Number(p.epoch) === 0) return proof.kind === 'never_acquired';
    if (
      proof.kind === 'never_acquired' ||
      proof.partitionId !== partitionId ||
      proof.ownerId !== p.owner_id ||
      proof.epoch !== Number(p.epoch) ||
      proof.tokenDigest !== p.token_digest
    )
      return false;
    const [audit] = await tx<{ proof: NativeOnceClosedProof }[]>`
      select proof from allrice_native_once_close_proofs where partition_id=${partitionId} and epoch=${Number(p.epoch)}`;
    return !!audit && isDeepStrictEqual(audit.proof, proof);
  }
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
  async function workspaceScope(tx: TransactionSql) {
    const loaded = await controls(tx);
    return {
      stateRoot: reference.stateRoot,
      controlSessionIds: new Set(
        loaded.map((r) => r.immutable_control.controlSessionId),
      ),
    };
  }
  function workspaceJson(tx: TransactionSql, value: unknown) {
    nativeOnceWorkspaceDigest(value, true);
    return tx.json(JSON.parse(JSON.stringify(value)));
  }
  async function workspaceSnapshot(
    tx: TransactionSql,
    p: Partition,
    scope: NativeOnceWorkspaceScope,
  ): Promise<NativeOnceWorkspaceSnapshot> {
    const [latest] = await tx<WorkspaceJournalRow[]>`
      select * from allrice_native_once_journal
      where partition_id=${partitionId} and entry_kind='workspace'
      order by (after_snapshot->>'revision')::bigint desc limit 1`;
    if (p.workspace_snapshot === null) {
      if (latest) reject('workspace_snapshot_missing');
      return {
        unitVersion: 2,
        revision: 0,
        tables: { workspaces: {} },
        global: null,
      };
    }
    validateNativeOnceWorkspaceSnapshot(p.workspace_snapshot, scope);
    if (
      !latest ||
      p.workspace_snapshot.revision < 1 ||
      !isDeepStrictEqual(latest.reference, reference) ||
      !isDeepStrictEqual(latest.after_snapshot, p.workspace_snapshot) ||
      latest.after_digest !== nativeOnceWorkspaceDigest(p.workspace_snapshot)
    )
      reject('workspace_snapshot_journal_mismatch');
    return structuredClone(p.workspace_snapshot);
  }
  /** Exact historical ACK only, never a live permission or writer renewal. */
  async function exactWorkspace(
    tx: TransactionSql,
    w: NativeOnceWriter,
    write: NativeOnceWorkspaceWrite,
    scope: NativeOnceWorkspaceScope,
  ): Promise<{ revision: number } | null> {
    if (w.partitionId !== partitionId) reject('workspace_writer_scope');
    validateNativeOnceWorkspaceWrite(write, scope);
    const [r] = await tx<WorkspaceJournalRow[]>`
      select * from allrice_native_once_journal
      where partition_id=${partitionId} and write_id=${write.writeId}`;
    if (!r) return null;
    if (
      r.entry_kind !== 'workspace' ||
      r.control_id !== null ||
      r.occurrence_id !== null
    )
      reject('workspace_journal_kind_conflict');
    const [p] = await tx<{ reference: NativeOnceReference }[]>`
      select reference from allrice_native_once_partitions where partition_id=${partitionId}`;
    if (
      !p ||
      !isDeepStrictEqual(p.reference, reference) ||
      !isDeepStrictEqual(r.reference, reference)
    )
      reject('workspace_reference_conflict');
    validateNativeOnceWorkspaceSnapshot(r.after_snapshot, scope);
    nativeOnceWorkspaceDigest(r.journal, true);
    const tokenDigest = nativeOnceDigest(w.token);
    const expectedRevision = write.expectedRevision + 1;
    const j = r.journal;
    const expected = {
      kind: 'workspace',
      unitVersion: 2,
      writer: { partitionId, ownerId: w.ownerId, epoch: w.epoch, tokenDigest },
      reference,
      write,
      beforeRevision: write.expectedRevision,
      afterRevision: expectedRevision,
      beforeDigest: j.beforeDigest,
      afterDigest: nativeOnceWorkspaceDigest(r.after_snapshot),
    };
    if (
      r.writer_owner_id !== w.ownerId ||
      Number(r.writer_epoch) !== w.epoch ||
      r.writer_token_digest !== tokenDigest ||
      r.write_digest !== write.digest ||
      !isDeepStrictEqual(r.mutation, write.mutation) ||
      r.after_snapshot.revision !== expectedRevision ||
      !/^sha256:[a-f0-9]{64}$/.test(j.beforeDigest) ||
      r.after_digest !== expected.afterDigest ||
      !isDeepStrictEqual(j, expected)
    )
      reject('workspace_exact_conflict');
    return { revision: expectedRevision };
  }
  async function loadWorkspaceUnit(
    given: NativeOnceWriter,
  ): Promise<NativeOnceWorkspaceSnapshot> {
    nativeOnceDigest(given);
    const w = structuredClone(given);
    return bounded(async (tx) => {
      const p = await partition(tx, 'share');
      await requireActive(tx, p, w);
      const scope = await workspaceScope(tx);
      const snapshot = await workspaceSnapshot(tx, p!, scope);
      await requireActive(tx, p, w);
      return snapshot;
    });
  }
  async function commitWorkspaceWrite(
    given: NativeOnceWriter,
    input: NativeOnceWorkspaceWrite,
  ): Promise<{ revision: number }> {
    nativeOnceDigest(given);
    nativeOnceWorkspaceDigest(input, true);
    const w = structuredClone(given),
      write = structuredClone(input);
    try {
      return await bounded(async (tx) => {
        const scope = await workspaceScope(tx);
        const prior = await exactWorkspace(tx, w, write, scope);
        if (prior) return prior;
        const p = await partition(tx, 'update');
        await requireActive(tx, p, w);
        // Same writeId may have committed while waiting for the partition.
        const committed = await exactWorkspace(tx, w, write, scope);
        if (committed) return committed;
        const before = await workspaceSnapshot(tx, p!, scope);
        const after = applyNativeOnceWorkspaceWrite(before, write, scope);
        const journal = {
          kind: 'workspace',
          unitVersion: 2,
          writer: {
            partitionId,
            ownerId: w.ownerId,
            epoch: w.epoch,
            tokenDigest: nativeOnceDigest(w.token),
          },
          reference,
          write,
          beforeRevision: before.revision,
          afterRevision: after.revision,
          beforeDigest: nativeOnceWorkspaceDigest(before),
          afterDigest: nativeOnceWorkspaceDigest(after),
        };
        nativeOnceWorkspaceDigest(journal, true);
        const done = await tx`
          update allrice_native_once_partitions set workspace_snapshot=${workspaceJson(tx, after)}
          where partition_id=${partitionId} and
            ((workspace_snapshot is null and ${before.revision}=0) or
             (workspace_snapshot->>'revision')::bigint=${before.revision})
          returning partition_id`;
        if (done.length !== 1) reject('workspace_revision_cas');
        await tx`insert into allrice_native_once_journal
          (partition_id,write_id,entry_kind,control_id,writer_owner_id,writer_epoch,writer_token_digest,
           reference,write_digest,mutation,journal,after_snapshot,after_digest,occurrence_id)
          values (${partitionId},${write.writeId},'workspace',null,${w.ownerId},${w.epoch},${journal.writer.tokenDigest},
            ${sqlJson(tx, reference)},${write.digest},${workspaceJson(tx, write.mutation)},${workspaceJson(tx, journal)},
            ${workspaceJson(tx, after)},${journal.afterDigest},null)`;
        await requireActive(tx, p, w);
        // The original deferred SQL COMMIT fence rechecks DB wall time after
        // all locks and writes. A stale epoch rolls back snapshot and journal.
        return { revision: after.revision };
      });
    } catch (error) {
      if (
        error instanceof NativeOnceWorkspaceError ||
        error instanceof NativeOnceSqlError ||
        error instanceof NativeOnceStateError ||
        (error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'P1920')
      )
        throw error;
      // COMMIT/network may be unknown. One primary read for the identical write;
      // never replay, allocate a new ID, recreate a snapshot or retry a mutation.
      try {
        const receipt = await bounded(
          async (tx) => exactWorkspace(tx, w, write, await workspaceScope(tx)),
          true,
        );
        if (receipt) return receipt;
      } catch {
        /* No complete proof: preserve the original unknown failure. */
      }
      throw error;
    }
  }

  return {
    loadWorkspaceUnit,
    commitWorkspaceWrite,
    async acquireWriter() {
      if (!nativeOnceReady(options.readiness?.())) return null;
      return bounded(async (tx) => {
        const p = await partition(tx, 'update');
        if (!p || !nativeOnceReady(readiness(p)) || !(await validClose(tx, p)))
          return null;
        const plan = planNativeOnceAcquire({
          readiness: readiness(p),
          row: asWriterRow(p),
          ownerId,
          token: randomUUID(),
          expectedReference: reference,
          dbNowMs: await dbNow(tx),
          ttlMs: ttl,
        });
        if (!plan) return null;
        await tx`update allrice_native_once_partitions set owner_id=${ownerId},epoch=${plan.writer.epoch},
          token_digest=${plan.row.tokenDigest},expires_at=to_timestamp(${plan.row.expiresAtMs!}::double precision/1000),
          closed=false,close_proof='null'::jsonb where partition_id=${partitionId}`;
        const loaded = await controls(tx);
        const remainingMs = nativeOnceWriterRemaining(
          plan.row,
          plan.writer,
          await dbNow(tx),
        );
        if (!remainingMs) reject('lease_lost');
        return {
          writer: plan.writer,
          remainingMs,
          reference: structuredClone(reference),
          controls: loaded.map((r) => structuredClone(r.snapshot.control)),
        };
      });
    },
    async renewWriter(given: NativeOnceWriter) {
      const w = structuredClone(given);
      return bounded(async (tx) => {
        const p = await partition(tx, 'update');
        const now = await dbNow(tx);
        if (!active(p, w, now)) return null;
        const renewed = planNativeOnceRenew(asWriterRow(p!), w, now, ttl);
        if (!renewed) return null;
        await tx`update allrice_native_once_partitions set expires_at=to_timestamp(${renewed.expiresAtMs!}::double precision/1000)
          where partition_id=${partitionId} and owner_id=${w.ownerId} and epoch=${w.epoch} and token_digest=${nativeOnceDigest(w.token)} and not closed
          and expires_at>clock_timestamp()`;
        const fresh = await partition(tx, 'share');
        const remainingMs =
          fresh && active(fresh, w, await dbNow(tx))
            ? nativeOnceWriterRemaining(asWriterRow(fresh), w, await dbNow(tx))
            : 0;
        return remainingMs > 0
          ? { writer: structuredClone(w), remainingMs }
          : null;
      });
    },
    async assertWriter(given: NativeOnceWriter) {
      const w = structuredClone(given);
      return bounded(async (tx) =>
        active(await partition(tx, 'share'), w, await dbNow(tx)),
      );
    },
    async loadControls(given: NativeOnceWriter) {
      const w = structuredClone(given);
      return bounded(async (tx) => {
        const p = await partition(tx, 'share');
        await requireActive(tx, p, w);
        const loaded = await controls(tx);
        await requireActive(tx, p, w);
        return loaded.map((r) => structuredClone(r.snapshot.control));
      });
    },
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
    async releaseClosedWriter(given: NativeOnceWriter) {
      const w = structuredClone(given);
      const proof = structuredClone(
        await options.proveClosed(structuredClone(w)),
      );
      if (
        !proof ||
        !['public_host_backend_drained', 'verified_process_exit'].includes(
          proof.kind,
        ) ||
        !id(proof.proofId) ||
        proof.partitionId !== w.partitionId ||
        proof.partitionId !== partitionId ||
        proof.ownerId !== w.ownerId ||
        proof.epoch !== w.epoch ||
        proof.tokenDigest !== nativeOnceDigest(w.token) ||
        !proof.evidence ||
        typeof proof.evidence !== 'object' ||
        Array.isArray(proof.evidence) ||
        !Object.keys(proof.evidence).length
      )
        reject('close_proof_required');
      nativeOnceDigest(proof);
      await bounded(async (tx) => {
        const p = await partition(tx, 'update');
        if (!p || !planNativeOnceClosed(asWriterRow(p), w))
          reject('close_fence');
        if (p.closed) {
          if (
            !(await validClose(tx, p)) ||
            !isDeepStrictEqual(p.close_proof, proof)
          )
            reject('close_proof_conflict');
          return;
        }
        await tx`insert into allrice_native_once_close_proofs(partition_id,epoch,proof_id,proof)
          values (${partitionId},${w.epoch},${proof.proofId},${sqlJson(tx, proof)})`;
        const done =
          await tx`update allrice_native_once_partitions set closed=true,close_proof=${sqlJson(tx, proof)}
          where partition_id=${partitionId} and owner_id=${w.ownerId} and epoch=${w.epoch} and token_digest=${nativeOnceDigest(w.token)}
          and not closed returning partition_id`;
        if (done.length !== 1) reject('close_fence');
      });
    },
  };
}
