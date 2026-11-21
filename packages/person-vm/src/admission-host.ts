import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { RequestContext } from '@allrice/contracts';
import {
  PersonVmError,
  PERSON_VM_IDLE_MS,
  type PersonVmAction,
  type PersonVmAuthority,
  type PersonVmBinding,
  type PersonVmView,
} from './contract.ts';
import type {
  PersonVmAdmissionBoundary,
  PersonVmAdmissionPermit,
} from './admission-boundary.ts';
import type {
  PersonVmActivityCursor,
  PersonVmAdmissionAuthorityPort,
  PersonVmAdmissionLease,
  PersonVmAdmissionObservation,
  PersonVmAdmissionParticipant,
  PersonVmAdmissionPort,
  PersonVmAdmissionSubscription,
  PersonVmIdleCoverage,
  PersonVmNativeActivityPort,
} from './admission-contract.ts';
import {
  type PostgresPersonVmAdmissionStore,
  released,
  rowBinding,
  sameBinding,
  sameLease,
  type AdmissionTransaction,
} from './admission-store.ts';
import type { PersonVmStore, VmLease, VmRecord } from './store.ts';

type OwnedPermit = {
  context: RequestContext;
  operationId: string;
  owner: string;
  source: string;
  freeze: PersonVmAdmissionLease | null;
  controller: AbortController;
  pending: Set<Promise<unknown>>;
  finish?: Promise<void>;
  closing: boolean;
  activated: boolean;
  joined: boolean;
  unsafe: boolean;
  detach(): void;
};
type Frame = { personId: string; lease: VmLease; active: boolean };
const cursorEqual = (
  a: PersonVmActivityCursor | null,
  b: PersonVmActivityCursor | null,
) => a?.sourceId === b?.sourceId && a?.revision === b?.revision;
type IdleCandidate = { key: string; mono: number };

/** @internal Actual candidate calculation; deliberately not a package export.
 * Notification revisions wake readers, while accepted revisions interrupt idle. */
export function advanceIdleCandidate(
  previous: IdleCandidate | undefined,
  binding: PersonVmBinding,
  coverage: readonly PersonVmIdleCoverage[],
  acceptedRevisions: readonly (string | undefined)[],
  row: Pick<VmRecord, 'holds' | 'lastActivityAt'> | null,
  mono: number,
): IdleCandidate | undefined {
  if (
    row?.holds.length ||
    coverage.some((value) => value.state !== 'continuous' || !value.idleSince)
  )
    return undefined;
  const key = JSON.stringify([
    binding,
    coverage.map((value) => [
      value.cursor?.sourceId,
      value.state === 'continuous' ? value.idleSince : null,
    ]),
    acceptedRevisions,
    row?.lastActivityAt,
  ]);
  return !previous || previous.key !== key || mono < previous.mono
    ? { key, mono }
    : previous;
}

/** Instantiate through PersonVmService.createAdmissionHost: actual store owner
 * and private owned lifecycle callbacks, never public stop/start recursion. */
export class PersonVmAdmissionHost
  implements PersonVmAdmissionAuthorityPort, PersonVmAdmissionBoundary
{
  private readonly frames = new AsyncLocalStorage<Frame>();
  private readonly permits = new WeakMap<
    PersonVmAdmissionPermit,
    OwnedPermit
  >();
  // Only failed admit calls that never returned a handle/callback. Not TTL takeover.
  private readonly unacknowledged = new Set<string>();
  private readonly projection = randomUUID();
  private readonly windows = new Map<
    string,
    { revision: string; at: string; mono: number }
  >();
  private readonly idle = new Map<string, IdleCandidate>();
  constructor(
    private readonly options: {
      shared: PostgresPersonVmAdmissionStore;
      store: PersonVmStore;
      authority: PersonVmAuthority;
      leaseTtlMs: number;
      now: () => Date;
      monotonic?: () => number;
      nativeActivity?: PersonVmNativeActivityPort;
      startOwned(
        context: RequestContext,
        lease: VmLease,
        signal: AbortSignal,
      ): Promise<PersonVmBinding>;
      stopOwned(
        context: RequestContext,
        lease: VmLease,
        signal: AbortSignal,
      ): Promise<PersonVmView>;
      assertStopSafe(lease: VmLease, signal: AbortSignal): Promise<void>;
    },
  ) {}
  private mono() {
    return (this.options.monotonic ?? (() => performance.now()))();
  }
  /** Bounded current owner, not another ownership registry. Revocation/PG loss
   * aborts it, but release waits for the real callback and control reads. */
  async trackOwner<T>(
    personId: string,
    signal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
  ) {
    const abort = new AbortController();
    let checking = Promise.resolve();
    let closing = false;
    const verify = () => {
      if (closing) return;
      checking = checking
        .then(() => this.options.shared.assertNotRevoked(personId, signal))
        .catch((error) => {
          abort.abort(error);
        });
    };
    const listener = await this.options.shared.listen(personId, verify, signal);
    const current = AbortSignal.any([signal, abort.signal, listener.signal]);
    try {
      verify();
      await checking;
      current.throwIfAborted();
      return await operation(current);
    } finally {
      closing = true;
      await checking;
      await listener.close();
    }
  }
  private async authorize(
    context: RequestContext,
    binding: PersonVmBinding,
    signal: AbortSignal,
    action: PersonVmAction = 'read',
  ) {
    signal.throwIfAborted();
    const identity = await this.options.authority.authorize(
      context,
      action,
      signal,
    );
    if (
      identity.personId !== binding.personId ||
      identity.organizationId !== binding.organizationId ||
      context.organizationId !== binding.organizationId ||
      context.actor.type !== 'user' ||
      context.actor.id !== binding.personId
    )
      throw new PersonVmError('AUTHORIZATION_DENIED');
  }
  private check(tx: AdmissionTransaction, binding: PersonVmBinding) {
    if (!sameBinding(rowBinding(tx.row), binding))
      throw new PersonVmError('LEASE_LOST');
    if (tx.state.revoked) throw new PersonVmError('AUTHORIZATION_DENIED');
  }
  private exact(tx: AdmissionTransaction, lease: PersonVmAdmissionLease) {
    this.check(tx, lease.binding);
    const round = tx.state.round;
    if (
      !round ||
      tx.version !== lease.version ||
      !sameLease(round.lease, lease)
    )
      throw new PersonVmError('LEASE_LOST');
    return round;
  }
  async issue(
    context: RequestContext,
    binding: PersonVmBinding,
    signal: AbortSignal,
  ) {
    await this.authorize(context, binding, signal, 'stop');
    return this.options.store.withLease(
      binding.personId,
      { now: this.options.now, ttlMs: this.options.leaseTtlMs },
      async (owned) => {
        const current = AbortSignal.any([signal, owned.signal]);
        const result = await this.options.shared.transaction(
          binding.personId,
          current,
          async (tx) => {
            this.check(tx, binding);
            if (tx.state.round && !released(tx.state.round))
              return tx.state.round.lease;
            if (
              tx.state.round &&
              !['none', 'confirmed'].includes(tx.state.round.stop)
            )
              throw new PersonVmError('CLEANUP_INCOMPLETE');
            if (tx.state.previous) tx.state.history.push(tx.state.previous);
            const references =
              await tx.sql`select distinct freeze_id from person_vm_admission_permits
            where person_id=${binding.personId} and disposition='deferred'`;
            tx.state.history = tx.state.history.filter((round) =>
              references.some((row) => row.freeze_id === round.lease.freezeId),
            );
            tx.state.previous = tx.state.round ?? tx.state.previous;
            const lease = {
              binding: Object.freeze({ ...binding }),
              freezeId: randomUUID(),
              version: randomUUID(),
            };
            tx.version = lease.version;
            tx.state.round = { lease, frozen: [], released: [], stop: 'none' };
            tx.touch();
            return lease;
          },
        );
        await owned.audit(owned.row!, {
          requestId: result.freezeId,
          action: 'admission.issue',
          result: 'succeeded',
        });
        return result;
      },
    );
  }
  async assertLease(lease: PersonVmAdmissionLease, signal: AbortSignal) {
    await this.options.shared.transaction(
      lease.binding.personId,
      signal,
      async (tx) => {
        this.exact(tx, lease);
      },
    );
  }
  async withLease<T>(
    lease: PersonVmAdmissionLease,
    operation: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ) {
    const active = this.frames.getStore();
    if (active?.active && active.personId === lease.binding.personId)
      throw new PersonVmError('LEASE_CONFLICT');
    return this.options.store.withLease(
      lease.binding.personId,
      { now: this.options.now, ttlMs: this.options.leaseTtlMs },
      async (owned) => {
        const current = AbortSignal.any([signal, owned.signal]);
        await this.assertLease(lease, current);
        const frame = {
          personId: lease.binding.personId,
          lease: owned,
          active: true,
        };
        return this.frames.run(frame, async () => {
          try {
            return await this.trackOwner(
              lease.binding.personId,
              current,
              operation,
            );
          } finally {
            frame.active = false;
          }
        });
      },
    );
  }
  private cursor(tx: AdmissionTransaction): PersonVmActivityCursor {
    return {
      sourceId: this.projection + ':' + tx.state.sourceId,
      revision: tx.revision,
    };
  }
  private async observation(
    tx: AdmissionTransaction,
    participant: PersonVmAdmissionParticipant,
  ): Promise<PersonVmAdmissionObservation> {
    const counts = await this.options.shared.counts(tx, participant);
    const cursor = this.cursor(tx);
    const key = tx.state.binding.personId + ':' + participant;
    const mono = this.mono();
    let window = this.windows.get(key);
    const idleRevision =
      tx.state.sourceId + ':' + tx.state[participant].idleRevision;
    if (!window || window.revision !== idleRevision || mono < window.mono) {
      window = {
        revision: idleRevision,
        at: this.options.now().toISOString(),
        mono,
      };
      this.windows.set(key, window);
    }
    const through = new Date(
      Date.parse(window.at) + mono - window.mono,
    ).toISOString();
    const round = tx.state.round;
    return {
      binding: rowBinding(tx.row),
      participant,
      observedAt: through,
      state: 'known',
      ...counts,
      frozen:
        round?.frozen.includes(participant) &&
        !round.released.includes(participant)
          ? round.lease
          : null,
      coverage: {
        state: 'continuous',
        cursor,
        from: window.at,
        through,
        idleSince: counts.active + counts.queued === 0 ? window.at : null,
      },
    };
  }
  participant(
    participant: PersonVmAdmissionParticipant,
  ): PersonVmAdmissionPort {
    return {
      participant,
      observe: (binding, signal) =>
        this.options.shared.transaction(
          binding.personId,
          signal,
          async (tx) => {
            this.check(tx, binding);
            return this.observation(tx, participant);
          },
        ),
      subscribe: (binding, signal) =>
        this.subscribe(binding, participant, signal),
      freeze: async (lease, signal) =>
        this.withLease(
          lease,
          async (current) => {
            const result = await this.options.shared.transaction(
              lease.binding.personId,
              current,
              async (tx) => {
                const round = this.exact(tx, lease);
                if (round.released.includes(participant))
                  throw new PersonVmError('LEASE_LOST');
                if (!round.frozen.includes(participant)) {
                  round.frozen.push(participant);
                  tx.touch(participant);
                }
                return this.observation(tx, participant);
              },
            );
            const owned = this.frames.getStore()!.lease;
            await owned.audit(owned.row!, {
              requestId: lease.freezeId,
              action: 'admission.freeze.' + participant,
              result: 'succeeded',
            });
            return result;
          },
          signal,
        ),
      assertFrozen: async (lease, signal) =>
        this.options.shared.transaction(
          lease.binding.personId,
          signal,
          async (tx) => {
            const round = this.exact(tx, lease);
            if (
              !round.frozen.includes(participant) ||
              round.released.includes(participant)
            )
              throw new PersonVmError('LEASE_LOST');
          },
        ),
      thaw: async (lease, signal) => {
        // Only an exact older release receipt proves already-released. No epoch exception.
        const old = await this.options.shared.transaction(
          lease.binding.personId,
          signal,
          async (tx) => {
            const round = tx.state.round ?? tx.state.previous;
            return (
              round &&
              sameLease(round.lease, lease) &&
              round.released.includes(participant)
            );
          },
        );
        if (old) return 'already-released';
        try {
          return await this.withLease(
            lease,
            async (current) => {
              const result = await this.options.shared.transaction(
                lease.binding.personId,
                current,
                async (tx) => {
                  const round = this.exact(tx, lease);
                  if (!['none', 'confirmed'].includes(round.stop))
                    throw new PersonVmError('CLEANUP_INCOMPLETE');
                  if (!round.released.includes(participant)) {
                    round.released.push(participant);
                    tx.touch(participant);
                  }
                  return 'released' as const;
                },
              );
              const owned = this.frames.getStore()!.lease;
              await owned.audit(owned.row!, {
                requestId: lease.freezeId,
                action: 'admission.release.' + participant,
                result: 'succeeded',
              });
              return result;
            },
            signal,
          );
        } catch (error) {
          if (error instanceof PersonVmError && error.code === 'LEASE_LOST')
            return 'superseded';
          throw error;
        }
      },
    };
  }
  private async subscribe(
    binding: PersonVmBinding,
    participant: PersonVmAdmissionParticipant,
    signal: AbortSignal,
  ): Promise<PersonVmAdmissionSubscription> {
    const closeSignal = new AbortController();
    const waits = new Set<Promise<void>>(),
      checks = new Set<Promise<void>>(),
      pulses = new Set<() => void>();
    const wake = () => {
      for (const pulse of [...pulses]) pulse();
    };
    const listener = await this.options.shared.listen(
      binding.personId,
      wake,
      signal,
    );
    const initial = await this.participant(participant)
      .observe(binding, signal)
      .catch(async (error) => {
        await listener.close();
        throw error;
      });
    const initialCursor = initial.coverage.cursor;
    let closing: Promise<void> | undefined;
    return {
      wait: (after, waitSignal) => {
        const current = AbortSignal.any([
          signal,
          waitSignal,
          closeSignal.signal,
          listener.signal,
        ]);
        const promise = new Promise<void>((resolve, reject) => {
          const clean = () => {
            pulses.delete(check);
            current.removeEventListener('abort', abort);
          };
          const abort = () => {
            clean();
            reject(current.reason);
          };
          let checking = false,
            again = false;
          const check = () => {
            if (checking) {
              again = true;
              return;
            }
            checking = true;
            const query = this.participant(participant)
              .observe(binding, current)
              .then(
                (value) => {
                  if (
                    !cursorEqual(after ?? initialCursor, value.coverage.cursor)
                  ) {
                    clean();
                    resolve();
                  }
                },
                (error) => {
                  clean();
                  reject(error);
                },
              )
              .finally(() => {
                checking = false;
                if (again) {
                  again = false;
                  if (pulses.has(check)) check();
                }
              });
            checks.add(query);
            void query.finally(() => checks.delete(query)).catch(() => {});
          };
          pulses.add(check);
          current.addEventListener('abort', abort, { once: true });
          if (current.aborted) abort();
          else check();
        });
        waits.add(promise);
        void promise.finally(() => waits.delete(promise)).catch(() => {});
        return promise;
      },
      close: () =>
        (closing ??= (async () => {
          closeSignal.abort(new PersonVmError('LEASE_LOST'));
          wake();
          await Promise.allSettled([...waits]);
          await Promise.allSettled([...checks]);
          await listener.close();
        })()),
    };
  }
  async admit(
    context: RequestContext,
    binding: PersonVmBinding,
    input: { participant: PersonVmAdmissionParticipant; operationId: string },
    signal: AbortSignal,
  ) {
    await this.authorize(context, binding, signal);
    if (!['gateway', 'entry'].includes(input.participant) || !input.operationId)
      throw new PersonVmError('AUTHORIZATION_DENIED');
    const owner = randomUUID(),
      permitId = randomUUID();
    let issued: {
      disposition: 'queued' | 'deferred';
      source: string;
      freeze: PersonVmAdmissionLease | null;
    };
    try {
      issued = await this.options.shared.transaction(
        binding.personId,
        signal,
        async (tx) => {
          this.check(tx, binding);
          const frozen =
            tx.state.round?.frozen.includes(input.participant) &&
            !released(tx.state.round);
          const freezeOwner = tx.state.round && !released(tx.state.round);
          if (
            !frozen &&
            (tx.row.phase !== 'running' || (tx.row.lease_owner && !freezeOwner))
          )
            throw new PersonVmError('RUNTIME_NOT_READY');
          const disposition = frozen ? 'deferred' : 'queued';
          const [previous] =
            await tx.sql`select * from person_vm_admission_permits where person_id=${binding.personId}
        and instance_id=${binding.instanceId} and lease_epoch=${binding.leaseEpoch}
        and participant=${input.participant} and operation_id=${input.operationId}`;
          if (previous) {
            if (!this.unacknowledged.has(String(previous.owner_ref)))
              throw new PersonVmError('LEASE_CONFLICT');
            await tx.sql`delete from person_vm_admission_permits where permit_id=${previous.permit_id}`;
          }
          const freeze = frozen ? tx.state.round!.lease : null;
          await tx.sql`insert into person_vm_admission_permits(permit_id,person_id,vm_id,organization_id,instance_id,
        lease_epoch,participant,operation_id,owner_ref,disposition,freeze_id,freeze_version) values(${permitId},${binding.personId},${binding.vmId},
        ${binding.organizationId},${binding.instanceId},${binding.leaseEpoch},${input.participant},${input.operationId},${owner},${disposition},${freeze?.freezeId ?? null},${freeze?.version ?? null})`;
          tx.touch(input.participant, disposition === 'queued');
          return { disposition, source: tx.state.sourceId, freeze } as const;
        },
      );
    } catch (error) {
      this.unacknowledged.add(owner);
      throw error;
    }
    const { disposition, source, freeze } = issued;
    const controller = new AbortController();
    const cancel = () => controller.abort(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    const permit = Object.freeze({
      permitId,
      binding: Object.freeze({ ...binding }),
      participant: input.participant,
      disposition,
      signal: controller.signal,
    });
    this.permits.set(permit, {
      context,
      operationId: input.operationId,
      owner,
      source,
      freeze,
      controller,
      pending: new Set(),
      closing: false,
      activated: false,
      joined: false,
      unsafe: false,
      detach: () => signal.removeEventListener('abort', cancel),
    });
    return permit;
  }
  private owned(permit: PersonVmAdmissionPermit) {
    const owned = this.permits.get(permit);
    if (!owned) throw new PersonVmError('LEASE_LOST');
    return owned;
  }
  private run<T>(
    permit: PersonVmAdmissionPermit,
    active: boolean,
    operation: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    const owned = this.owned(permit);
    if (owned.closing || owned.activated || permit.disposition === 'deferred')
      return Promise.reject(new PersonVmError('LEASE_CONFLICT'));
    if (active) owned.activated = true;
    const promise = Promise.resolve().then(async () => {
      const current = AbortSignal.any([signal, permit.signal]);
      current.throwIfAborted();
      let checking = Promise.resolve();
      let closing = false;
      const verify = () => {
        if (closing) return;
        checking = checking
          .then(async () => {
            await this.options.shared.transaction(
              permit.binding.personId,
              current,
              async (tx) => {
                this.check(tx, permit.binding);
                if (tx.state.sourceId !== owned.source)
                  throw new PersonVmError('LEASE_LOST');
              },
            );
          })
          .catch((error) => {
            owned.controller.abort(error);
          });
      };
      const listener = await this.options.shared.listen(
        permit.binding.personId,
        verify,
        current,
      );
      const lost = () => owned.controller.abort(listener.signal.reason);
      listener.signal.addEventListener('abort', lost, { once: true });
      if (listener.signal.aborted) lost();
      const operationSignal = AbortSignal.any([current, listener.signal]);
      const closeListener = async () => {
        try {
          await listener.close();
        } catch (error) {
          owned.unsafe = true;
          throw error;
        }
      };
      let entered = false;
      try {
        await this.authorize(owned.context, permit.binding, operationSignal);
        await this.options.shared.transaction(
          permit.binding.personId,
          operationSignal,
          async (tx) => {
            this.check(tx, permit.binding);
            if (tx.state.sourceId !== owned.source)
              throw new PersonVmError('LEASE_LOST');
            const [record] =
              await tx.sql`select * from person_vm_admission_permits where permit_id=${permit.permitId} and owner_ref=${owned.owner} for update`;
            if (!record || record.disposition === 'deferred')
              throw new PersonVmError('LEASE_LOST');
            if (active && record.disposition !== 'active') {
              await tx.sql`update person_vm_admission_permits set disposition='active' where permit_id=${permit.permitId}`;
              tx.touch(permit.participant, true);
            }
          },
        );
        operationSignal.throwIfAborted();
        entered = true;
        return await operation(operationSignal);
      } catch (error) {
        // Rejection after entry is not proof that actual children joined.
        // Confirmed business failure/cancellation must fulfil a local outcome;
        // an outer catch (including another queued callback) cannot undo this.
        if (entered) owned.unsafe = true;
        throw error;
      } finally {
        closing = true;
        listener.signal.removeEventListener('abort', lost);
        await checking;
        await closeListener();
      }
    });
    owned.pending.add(promise);
    void promise.finally(() => owned.pending.delete(promise)).catch(() => {});
    return promise;
  }
  async queued<T>(
    permit: PersonVmAdmissionPermit,
    operation: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ) {
    return this.run(permit, false, operation, signal);
  }
  async activate<T>(
    permit: PersonVmAdmissionPermit,
    operation: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ) {
    return this.run(permit, true, operation, signal);
  }
  finish(permit: PersonVmAdmissionPermit) {
    const owned = this.owned(permit);
    return (owned.finish ??= (async () => {
      owned.closing = true;
      owned.controller.abort(new PersonVmError('LEASE_LOST'));
      await Promise.allSettled([...owned.pending]);
      owned.detach();
      if (owned.unsafe) throw new PersonVmError('CLEANUP_INCOMPLETE');
      owned.joined = true;
      await this.releasePermit(permit, owned, new AbortController().signal);
    })());
  }
  private async releasePermit(
    permit: PersonVmAdmissionPermit,
    owned: OwnedPermit,
    signal: AbortSignal,
  ) {
    await this.options.shared.transaction(
      permit.binding.personId,
      signal,
      async (tx) => {
        const records =
          await tx.sql`delete from person_vm_admission_permits where permit_id=${permit.permitId}
          and owner_ref=${owned.owner} returning disposition`;
        if (records.length)
          tx.touch(permit.participant, records[0]!.disposition !== 'deferred');
      },
      true, // Actual join may finish after an authorized VM tombstone; never admit there.
    );
  }
  /** Explicit retry after same-process actual join but a lost finish write.
   * A foreign handle/host cannot use this proof; MET274 must fence its owner. */
  async recoverPermit(permit: PersonVmAdmissionPermit, signal: AbortSignal) {
    const owned = this.owned(permit);
    if (owned.finish) await owned.finish.catch(() => {});
    if (!owned.joined || owned.unsafe)
      throw new PersonVmError('CLEANUP_INCOMPLETE');
    await this.releasePermit(permit, owned, signal);
  }
  async waitUntilReady(
    context: RequestContext,
    permit: PersonVmAdmissionPermit,
    signal: AbortSignal,
  ) {
    const owned = this.owned(permit);
    if (owned.closing || permit.disposition !== 'deferred')
      throw new PersonVmError('LEASE_CONFLICT');
    const promise = (async () => {
      const current = AbortSignal.any([signal, permit.signal]);
      const oldReleased = () =>
        this.options.shared.transaction(
          permit.binding.personId,
          current,
          async (tx) => {
            const round = [
              tx.state.round,
              tx.state.previous,
              ...tx.state.history,
            ].find(
              (value) =>
                value && owned.freeze && sameLease(value.lease, owned.freeze),
            );
            return {
              released: !tx.state.revoked && Boolean(round && released(round)),
              cursor: this.cursor(tx),
            };
          },
        );
      let subscription: PersonVmAdmissionSubscription;
      try {
        subscription = await this.subscribe(
          permit.binding,
          permit.participant,
          current,
        );
      } catch (error) {
        if (
          error instanceof PersonVmError &&
          error.code === 'LEASE_LOST' &&
          (await oldReleased()).released
        )
          return this.wakeCurrent(
            context,
            permit.binding,
            current,
            owned.freeze!,
          );
        throw error;
      }
      try {
        for (;;) {
          await this.authorize(context, permit.binding, current);
          const barrier = await oldReleased();
          if (barrier.released)
            return await this.wakeCurrent(
              context,
              permit.binding,
              current,
              owned.freeze!,
            );
          try {
            // Predicate and watermark come from ONE locked snapshot. A peer
            // ACK between this read and wait remains visible in the PG revision.
            await subscription.wait(barrier.cursor, current);
          } catch (error) {
            // Another deferred waiter may already have completed the one wake.
            // Only authoritative old-round release can resolve this to ready.
            if (
              error instanceof PersonVmError &&
              error.code === 'LEASE_LOST' &&
              (await oldReleased()).released
            )
              return await this.wakeCurrent(
                context,
                permit.binding,
                current,
                owned.freeze!,
              );
            throw error;
          }
        }
      } finally {
        await subscription.close();
      }
    })();
    owned.pending.add(promise);
    void promise.finally(() => owned.pending.delete(promise)).catch(() => {});
    return promise;
  }
  async wake(
    context: RequestContext,
    previousBinding: PersonVmBinding,
    signal: AbortSignal,
  ) {
    return this.wakeCurrent(context, previousBinding, signal);
  }
  private wakeBarrier(
    tx: AdmissionTransaction,
    previousBinding: PersonVmBinding,
    receipt?: PersonVmAdmissionLease,
  ) {
    if (tx.state.revoked) throw new PersonVmError('AUTHORIZATION_DENIED');
    const currentBinding = rowBinding(tx.row);
    if (
      currentBinding.organizationId !== previousBinding.organizationId ||
      currentBinding.vmId !== previousBinding.vmId
    )
      throw new PersonVmError('ORGANIZATION_CONFLICT');
    const old = [tx.state.round, tx.state.previous, ...tx.state.history].find(
      (round) =>
        round &&
        (receipt
          ? sameLease(round.lease, receipt)
          : sameBinding(round.lease.binding, previousBinding)),
    );
    if (!old) throw new PersonVmError('LEASE_LOST');
    const current = tx.state.round;
    for (const round of [old, current])
      if (round && !round.demand) {
        round.demand = true;
        tx.touch();
      }
    // Old receipt proves only its own release. A later generation's gate is
    // independently closed until its exact dual release and known stop result.
    return [old, current].every(
      (round) =>
        !round ||
        (released(round) && ['none', 'confirmed'].includes(round.stop)),
    );
  }
  private async wakeCurrent(
    context: RequestContext,
    previousBinding: PersonVmBinding,
    signal: AbortSignal,
    receipt?: PersonVmAdmissionLease,
  ) {
    await this.authorize(context, previousBinding, signal, 'start');
    let sequence = 0;
    const pulses = new Set<() => void>();
    const listener = await this.options.shared.listen(
      previousBinding.personId,
      () => {
        sequence += 1;
        for (const pulse of [...pulses]) pulse();
      },
      signal,
    );
    const current = AbortSignal.any([signal, listener.signal]);
    const wait = (after: number) =>
      new Promise<void>((resolve, reject) => {
        const clean = () => {
          pulses.delete(check);
          current.removeEventListener('abort', abort);
        };
        const check = () => {
          if (sequence !== after) {
            clean();
            resolve();
          }
        };
        const abort = () => {
          clean();
          reject(current.reason);
        };
        pulses.add(check);
        current.addEventListener('abort', abort, { once: true });
        if (current.aborted) abort();
        else check();
      });
    try {
      for (;;) {
        const after = sequence;
        const barrier = await this.options.shared.transaction(
          previousBinding.personId,
          current,
          async (tx) => this.wakeBarrier(tx, previousBinding, receipt),
        );
        if (!barrier) {
          await wait(after);
          continue;
        }
        try {
          return await this.options.store.withLease(
            previousBinding.personId,
            { now: this.options.now, ttlMs: this.options.leaseTtlMs },
            async (owned) => {
              const operationSignal = AbortSignal.any([current, owned.signal]);
              await this.authorize(
                context,
                previousBinding,
                operationSignal,
                'start',
              );
              await this.options.shared.transaction(
                previousBinding.personId,
                operationSignal,
                async (tx) => {
                  if (!this.wakeBarrier(tx, previousBinding, receipt))
                    throw new PersonVmError('LEASE_CONFLICT');
                },
              );
              return this.trackOwner(
                previousBinding.personId,
                operationSignal,
                (ownedSignal) =>
                  this.options.startOwned(context, owned, ownedSignal),
              );
            },
          );
        } catch (error) {
          if (
            !(error instanceof PersonVmError) ||
            error.code !== 'LEASE_CONFLICT'
          )
            throw error;
          await wait(after); // A concurrent physical owner must truly settle first.
        }
      }
    } finally {
      await listener.close();
    }
  }
  /** No native admission barrier is invented here. The real lifecycle callback
   * permits cleanup of an already-stopped VM; running remains ACTIVITY_UNKNOWN. */
  async stopFrozen(
    context: RequestContext,
    lease: PersonVmAdmissionLease,
    signal: AbortSignal,
  ) {
    await this.authorize(context, lease.binding, signal, 'stop');
    return this.withLease(
      lease,
      async (current) => {
        const owned = this.frames.getStore()!.lease;
        await this.options.assertStopSafe(owned, current);
        await this.options.shared.transaction(
          lease.binding.personId,
          current,
          async (tx) => {
            const round = await this.stopFacts(tx, lease, false);
            round.stop = 'pending';
            tx.touch();
          },
        );
        try {
          const result = await this.options.stopOwned(context, owned, current);
          await this.options.shared.transaction(
            lease.binding.personId,
            current,
            async (tx) => {
              this.exact(tx, lease).stop = 'confirmed';
              tx.touch();
            },
          );
          return result;
        } catch (error) {
          await this.options.shared
            .transaction(
              lease.binding.personId,
              new AbortController().signal,
              async (tx) => {
                this.exact(tx, lease).stop = 'unknown';
                tx.touch();
              },
            )
            .catch(() => {}); // durable pending is equally closed after DB loss
          throw error;
        }
      },
      signal,
    );
  }
  private async stopFacts(
    tx: AdmissionTransaction,
    lease: PersonVmAdmissionLease,
    recovery: boolean,
  ) {
    const round = this.exact(tx, lease);
    if (recovery && !['pending', 'unknown'].includes(round.stop))
      throw new PersonVmError('LEASE_CONFLICT');
    for (const participant of ['gateway', 'entry'] as const) {
      if (
        !round.frozen.includes(participant) ||
        round.released.includes(participant)
      )
        throw new PersonVmError('LEASE_LOST');
      const counts = await this.options.shared.counts(tx, participant);
      if (counts.active + counts.queued) throw new PersonVmError('VM_ACTIVE');
    }
    if ((tx.row.holds as unknown[]).length)
      throw new PersonVmError('VM_ACTIVE');
    return round;
  }
  /** Explicit existing-store recovery. Consumes only that store's joined proof
   * or MET274's real fence, then claims a NEW recovery owner before providers. */
  async recoverStop(
    context: RequestContext,
    lease: PersonVmAdmissionLease,
    signal: AbortSignal,
  ) {
    await this.authorize(context, lease.binding, signal, 'stop');
    return this.options.store.recover(
      lease.binding.personId,
      { now: this.options.now, ttlMs: this.options.leaseTtlMs, signal },
      async (owned) => {
        const current = AbortSignal.any([signal, owned.signal]);
        return this.trackOwner(
          lease.binding.personId,
          current,
          async (ownedSignal) => {
            await this.options.shared.transaction(
              lease.binding.personId,
              ownedSignal,
              async (tx) => {
                await this.stopFacts(tx, lease, true);
              },
            );
            await this.options.assertStopSafe(owned, ownedSignal);
            const result = await this.options.stopOwned(
              context,
              owned,
              ownedSignal,
            );
            await this.options.shared.transaction(
              lease.binding.personId,
              ownedSignal,
              async (tx) => {
                this.exact(tx, lease).stop = 'confirmed';
                tx.touch();
              },
            );
            return result;
          },
        );
      },
    );
  }
  async reconcileIdle(
    context: RequestContext,
    binding: PersonVmBinding,
    signal: AbortSignal,
  ): Promise<void> {
    await this.authorize(context, binding, signal);
    if (!this.options.nativeActivity) {
      this.idle.delete(binding.personId);
      return;
    }
    const [[g, e, accepted], native, row] = await Promise.all([
      this.options.shared.transaction(binding.personId, signal, async (tx) => {
        this.check(tx, binding);
        return [
          await this.observation(tx, 'gateway'),
          await this.observation(tx, 'entry'),
          [tx.state.gateway.idleRevision, tx.state.entry.idleRevision],
        ] as const;
      }),
      this.options.nativeActivity.observe(binding, signal),
      this.options.store.read(binding.personId),
    ]);
    const coverage = [g.coverage, e.coverage, native.coverage];
    if (
      g.state !== 'known' ||
      e.state !== 'known' ||
      g.active + g.queued + e.active + e.queued ||
      !sameBinding(native.activity.binding, binding) ||
      native.activity.state !== 'known' ||
      native.activeScheduleDeliveries !== 0 ||
      native.activity.activeTurns +
        native.activity.activeJobs +
        native.activity.activeSubtasks +
        native.activity.pendingApprovals
    ) {
      this.idle.delete(binding.personId);
      return;
    }
    const mono = this.mono();
    const candidate = advanceIdleCandidate(
      this.idle.get(binding.personId),
      binding,
      coverage,
      [...accepted, native.coverage.cursor?.revision],
      row,
      mono,
    );
    if (!candidate) {
      this.idle.delete(binding.personId);
      return;
    }
    this.idle.set(binding.personId, candidate);
    if (mono - candidate.mono < PERSON_VM_IDLE_MS) return;
    // This composition has no native autonomous-admission barrier. Do not
    // freeze users merely because an injected projection looks complete: it
    // cannot commit a running stop. Keep the VM/open gates and the candidate.
    // Explicit stopFrozen also enforces native stopped/absent before cleanup.
    return;
  }
}
