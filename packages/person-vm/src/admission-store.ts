import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { PersonVmError, type PersonVmBinding } from './contract.ts';
import type {
  PersonVmAdmissionLease,
  PersonVmAdmissionParticipant,
} from './admission-contract.ts';
import { VmSqlSession, type PersonVmSqlFactory } from './store.ts';

export type AdmissionRound = {
  lease: PersonVmAdmissionLease;
  frozen: PersonVmAdmissionParticipant[];
  released: PersonVmAdmissionParticipant[];
  stop: 'none' | 'pending' | 'confirmed' | 'unknown';
  demand?: boolean;
};
export type AdmissionState = {
  sourceId: string;
  binding: PersonVmBinding;
  revoked: string | null;
  round: AdmissionRound | null;
  previous: AdmissionRound | null;
  history: AdmissionRound[];
  gateway: { revision: string; idleRevision: string };
  entry: { revision: string; idleRevision: string };
};
export type AdmissionTransaction = {
  sql: postgres.TransactionSql;
  row: Record<string, unknown>;
  state: AdmissionState;
  version: string;
  touch(participant?: PersonVmAdmissionParticipant, accepted?: boolean): void;
};
export const sameBinding = (a: PersonVmBinding, b: PersonVmBinding) =>
  a.personId === b.personId &&
  a.organizationId === b.organizationId &&
  a.vmId === b.vmId &&
  a.instanceId === b.instanceId &&
  a.leaseEpoch === b.leaseEpoch;
export const sameLease = (
  a: PersonVmAdmissionLease,
  b: PersonVmAdmissionLease,
) =>
  sameBinding(a.binding, b.binding) &&
  a.freezeId === b.freezeId &&
  a.version === b.version;
export const released = (round: AdmissionRound) =>
  round.released.length === 2 &&
  round.released.includes('gateway') &&
  round.released.includes('entry');
export function rowBinding(row: Record<string, unknown>): PersonVmBinding {
  if (!row.instance_id) throw new PersonVmError('RUNTIME_NOT_READY');
  return {
    personId: String(row.person_id),
    organizationId: String(row.organization_id),
    vmId: String(row.vm_id),
    instanceId: String(row.instance_id),
    leaseEpoch: Number(row.lease_epoch),
  };
}

/** Only this PG projection owns gate/permit facts. Local handles never count as authority. */
export class PostgresPersonVmAdmissionStore {
  constructor(private readonly openSql: PersonVmSqlFactory) {}
  async assertNotRevoked(personId: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const session = new VmSqlSession(this.openSql());
    try {
      const [row] = await session.query(
        () =>
          session.client`select admission_state from person_virtual_machines where person_id=${personId}`,
      );
      if (row?.admission_state?.revoked)
        throw new PersonVmError('AUTHORIZATION_DENIED');
      signal.throwIfAborted();
    } finally {
      await session.end();
    }
  }
  async transaction<T>(
    personId: string,
    signal: AbortSignal,
    work: (tx: AdmissionTransaction) => Promise<T>,
    allowDeleted = false,
  ): Promise<T> {
    signal.throwIfAborted();
    const session = new VmSqlSession(this.openSql());
    try {
      return (await session.query(() =>
        session.client.begin(async (sql) => {
          signal.throwIfAborted();
          const [row] =
            await sql`select * from person_virtual_machines where person_id=${personId} for update`;
          if (!row || (row.phase === 'deleted' && !allowDeleted))
            throw new PersonVmError('NOT_FOUND');
          if (!('admission_state' in row))
            throw new PersonVmError('PROVIDER_FAILED');
          const binding = rowBinding(row);
          let state = row.admission_state as AdmissionState;
          let version = row.admission_version as string | null;
          let dirty = false;
          if (version && !state.sourceId)
            throw new PersonVmError('PROVIDER_FAILED');
          if (!state.sourceId || !sameBinding(state.binding, binding)) {
            if (
              state.round &&
              (!released(state.round) ||
                !['none', 'confirmed'].includes(state.round.stop))
            )
              throw new PersonVmError('LEASE_LOST');
            state = {
              sourceId: randomUUID(),
              binding,
              revoked: state.revoked ?? null,
              previous: state.round ?? state.previous ?? null,
              history: [
                ...(state.history ?? []),
                ...(state.round && state.previous ? [state.previous] : []),
              ],
              round: null,
              gateway: { revision: '0', idleRevision: '0' },
              entry: { revision: '0', idleRevision: '0' },
            };
            version = randomUUID();
            dirty = true;
          }
          state.history ??= [];
          const tx: AdmissionTransaction = {
            sql,
            row,
            state,
            version: version!,
            touch: (participant, accepted = false) => {
              dirty = true;
              if (participant) {
                const cursor = state[participant];
                cursor.revision = String(BigInt(cursor.revision) + 1n);
                if (accepted)
                  cursor.idleRevision = String(
                    BigInt(cursor.idleRevision) + 1n,
                  );
              }
            },
          };
          const value = await work(tx);
          signal.throwIfAborted();
          if (dirty || tx.version !== version)
            await sql`update person_virtual_machines set admission_version=${tx.version},
            admission_state=${sql.json(state as unknown as postgres.JSONValue)},admission_revision=admission_revision+1
            where person_id=${personId}`;
          return value;
        }),
      )) as T;
    } finally {
      await session.end();
    }
  }

  async counts(
    tx: AdmissionTransaction,
    participant: PersonVmAdmissionParticipant,
  ) {
    const rows =
      await tx.sql`select disposition,count(*)::int as count from person_vm_admission_permits
      where person_id=${tx.state.binding.personId} and participant=${participant}
      group by disposition`;
    const counts = { active: 0, queued: 0, deferred: 0 };
    for (const row of rows)
      counts[row.disposition as keyof typeof counts] = Number(row.count);
    return counts;
  }

  /** Own one listener client. Unexpected close is a gap, never transparent recovery.
   * Notifications are hints; the consumer performs a fresh authoritative read. */
  async listen(personId: string, changed: () => void, signal: AbortSignal) {
    signal.throwIfAborted();
    const session = new VmSqlSession(this.openSql());
    let closing: Promise<void> | undefined;
    let listener: Awaited<ReturnType<postgres.Sql['listen']>> | undefined;
    const gap = new AbortController();
    let connections = 0;
    const changedIfOpen = () => {
      if (!closing) changed();
    };
    const lost = changedIfOpen;
    session.signal.addEventListener('abort', lost, { once: true });
    const close = () =>
      (closing ??= (async () => {
        session.signal.removeEventListener('abort', lost);
        // end(timeout:0) destroys BOTH this exclusive client and postgres.js's
        // owned notification client; never release/reuse a broken reservation.
        const detach = listener?.unlisten();
        const results = await Promise.allSettled([detach, session.end()]);
        if (results[1]?.status === 'rejected') throw results[1].reason;
      })());
    try {
      await session.query(() => session.client`select 1`); // Real owner liveness, separate from LISTEN hints.
      listener = await session.query(() =>
        session.client.listen(
          'allrice_person_vm_admission',
          (id) => {
            if (id === personId) changedIfOpen();
          },
          () => {
            if (++connections > 1) {
              gap.abort(new PersonVmError('LEASE_LOST'));
              changedIfOpen();
            }
          },
        ),
      );
      signal.throwIfAborted();
      if (session.signal.aborted) throw session.signal.reason;
      return { signal: AbortSignal.any([session.signal, gap.signal]), close };
    } catch (error) {
      await close();
      throw error;
    }
  }
}
