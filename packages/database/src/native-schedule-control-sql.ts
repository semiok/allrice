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
  type NativeOnceReadiness,
  type NativeOnceReference,
  type NativeOnceWriter,
  type NativeOnceWriterRow,
} from './native-schedule-once-state.ts';

/** Shared partition/writer/workspace SQL only; no scheduling or business admission. */
export class NativeOnceSqlError extends Error {
  constructor(readonly code: string) {
    super(`native_once_sql_${code}`);
  }
}
function reject(code: string): never {
  throw new NativeOnceSqlError(code);
}
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
/** Why the last acquireWriter returned null. A refused takeover is otherwise silent:
 * the controller just stays cold (MET-210 #3). */
export interface NativeScheduleTakeoverRefusal {
  code:
    | 'deployment_not_ready'
    | 'partition_missing'
    | 'activation_not_ready'
    | 'held'
    | 'held_expired_without_close_proof'
    | 'close_proof_missing'
    | 'close_proof_invalid'
    | 'acquire_plan_rejected';
  ownerId: string | null;
  epoch: number;
  expiresAtMs: number | null;
}
export interface NativeScheduleControlSqlOptions<
  C extends { controlSessionId: string },
> {
  /** Primary connection only; caller owns its lifetime. */
  db: Sql;
  partitionId: string;
  ownerId: string;
  reference: NativeOnceReference;
  ttlMs?: number;
  readiness?: () => NativeOnceReadiness;
  /** Format-owned validation and projection, in the supplied transaction.
   * The common store never reads a once/recurring business control table. */
  loadControls: (tx: TransactionSql) => Promise<C[]>;
  /** Exact completed Host/backend drain or independently verified process exit.
   * Null refuses release; an expired lease is never a close proof. */
  proveClosed: (
    writer: NativeOnceWriter,
  ) => Promise<NativeOnceClosedProof | null>;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
}
export type NativeScheduleControlPartition = {
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
type Partition = NativeScheduleControlPartition;
type WorkspaceJournalRow = {
  write_id: string;
  entry_kind: 'control' | 'workspace';
  control_id: string | null;
  writer_owner_id: string;
  writer_epoch: string | number;
  writer_token_digest: string;
  reference: NativeOnceReference;
  write_digest: string;
  mutation: NativeOnceWorkspaceWrite['mutation'];
  after_snapshot: NativeOnceWorkspaceSnapshot;
  after_digest: string;
  occurrence_id: string | null;
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
const asWriterRow = (p: Partition): NativeOnceWriterRow => ({
  partitionId: p.partition_id,
  ownerId: p.owner_id,
  epoch: Number(p.epoch),
  tokenDigest: p.token_digest,
  expiresAtMs: p.expires_at_ms,
  closed: p.closed,
  reference: p.reference,
});

/** Same persisted partition, close-proof audit and workspace-only journal used by
 * each control format. Format-specific mutations/receipts stay with the caller.
 * SQL/COMMIT uncertainty is never a permission to repeat a mutation. */
export function createNativeScheduleControlSqlStore<
  C extends { controlSessionId: string },
>(options: NativeScheduleControlSqlOptions<C>) {
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
    typeof options.loadControls !== 'function' ||
    typeof options.proveClosed !== 'function'
  )
    reject('configuration_invalid');
  const partitionId = options.partitionId;
  const ownerId = options.ownerId;
  let refusal: NativeScheduleTakeoverRefusal | null = null;
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
  async function workspaceScope(tx: TransactionSql) {
    const loaded = await options.loadControls(tx);
    return {
      stateRoot: reference.stateRoot,
      controlSessionIds: new Set(
        loaded.map((control) => control.controlSessionId),
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
    // Internal format adapter ports. Keep the same transaction and final fence.
    bounded,
    partition,
    requireActive,
    readiness,
    asWriterRow,
    loadWorkspaceUnit,
    commitWorkspaceWrite,
    takeoverRefusal: () => refusal && { ...refusal },
    async acquireWriter() {
      const refuse = (
        code: NativeScheduleTakeoverRefusal['code'],
        p?: Partition,
      ) => {
        refusal = {
          code,
          ownerId: p?.owner_id ?? null,
          epoch: Number(p?.epoch ?? 0),
          expiresAtMs: p?.expires_at_ms ?? null,
        };
        return null;
      };
      refusal = null;
      if (!nativeOnceReady(options.readiness?.()))
        return refuse('deployment_not_ready');
      return bounded(async (tx) => {
        const p = await partition(tx, 'update');
        if (!p) return refuse('partition_missing');
        if (!nativeOnceReady(readiness(p)))
          return refuse('activation_not_ready', p);
        // Diagnosis only, so no extra statement in this locked transaction: the
        // Worker clock tells a live lease from an expired one well enough.
        if (!(await validClose(tx, p)))
          return refuse(
            p.closed
              ? p.close_proof
                ? 'close_proof_invalid'
                : 'close_proof_missing'
              : p.expires_at_ms !== null && p.expires_at_ms <= Date.now()
                ? 'held_expired_without_close_proof'
                : 'held',
            p,
          );
        const plan = planNativeOnceAcquire({
          readiness: readiness(p),
          row: asWriterRow(p),
          ownerId,
          token: randomUUID(),
          expectedReference: reference,
          dbNowMs: await dbNow(tx),
          ttlMs: ttl,
        });
        if (!plan) return refuse('acquire_plan_rejected', p); // readiness and closed are checked above
        await tx`update allrice_native_once_partitions set owner_id=${ownerId},epoch=${plan.writer.epoch},
          token_digest=${plan.row.tokenDigest},expires_at=to_timestamp(${plan.row.expiresAtMs!}::double precision/1000),
          closed=false,close_proof='null'::jsonb where partition_id=${partitionId}`;
        const loaded = await options.loadControls(tx);
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
          controls: loaded.map((control) => structuredClone(control)),
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
        const loaded = await options.loadControls(tx);
        await requireActive(tx, p, w);
        return loaded.map((control) => structuredClone(control));
      });
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
