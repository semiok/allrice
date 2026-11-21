import type { RequestContext } from '@allrice/contracts';
import type { PersonVmActivity, PersonVmBinding } from './contract.ts';

export const PERSON_VM_ADMISSION_CONTRACT_VERSION = 1 as const;

/** HOST ONLY: issued by the model host's shared authority, never guest JSON.
 * All five binding fields must match. version is an opaque, non-reused CAS
 * revision for this admission lease; it does not replace VM leaseEpoch.
 * No expiry grants permission to dispatch, thaw, or take over this lease. */
export type PersonVmAdmissionLease = Readonly<{
  binding: PersonVmBinding;
  freezeId: string;
  version: string;
}>;

/** Equality only. sourceId changes on source/owner replacement or loss of
 * continuity; revision changes even for a short start/end between observations. */
export type PersonVmActivityCursor = Readonly<{
  sourceId: string;
  revision: string;
}>;

/** Proposed public-fact projection, NOT a producer supplied by this module.
 * Continuous covers every relevant transition in [from, through]. idleSince
 * is the latest transition to no admitted activity, or null while non-idle.
 * from <= idleSince <= through; all instants use a trusted host time domain,
 * with elapsed duration proved by a monotonic clock. A gap is unknown. */
export type PersonVmIdleCoverage =
  | Readonly<{
      state: 'continuous';
      cursor: PersonVmActivityCursor;
      from: string;
      through: string;
      idleSince: string | null;
    }>
  | Readonly<{
      state: 'unknown';
      cursor: PersonVmActivityCursor | null;
      reason: string;
    }>;

export type PersonVmAdmissionParticipant = 'gateway' | 'entry';

export type PersonVmAdmissionObservation = Readonly<{
  binding: PersonVmBinding;
  participant: PersonVmAdmissionParticipant;
  observedAt: string;
}> &
  (
    | Readonly<{
        state: 'known';
        /** Nonnegative integers. Gateway includes model/refresh transports and
         * actual drain. Entry includes admitted connections/typing/prewarm. */
        active: number;
        /** Admitted BEFORE freeze, including memory/8-slot/other host waits.
         * Never move these requests into deferred to manufacture zero. */
        queued: number;
        /** Arrived AFTER freeze; no native/transport work admitted yet. These
         * remain cancelable demand, but do not reset the admitted idle window. */
        deferred: number;
        frozen: PersonVmAdmissionLease | null;
        coverage: PersonVmIdleCoverage;
      }>
    | Readonly<{
        state: 'unknown';
        reason: string;
        coverage: PersonVmIdleCoverage;
      }>
  );

/** Subscribe before observe. wait is latched, including changes between the
 * read and wait; changed cursor/source or a source gap must wake the waiter.
 * null uses the subscription's initial watermark. No polling interval implied. */
export interface PersonVmAdmissionSubscription {
  wait(
    after: PersonVmActivityCursor | null,
    signal: AbortSignal,
  ): Promise<void>;
  /** Idempotently cancel/join this subscription's waits. Does NOT thaw a gate,
   * close its owner, cancel accepted work, or prove remote effects settled. */
  close(): Promise<void>;
}

/** Proposed participant protocol, identical for gateway and entry. These
 * host-only calls require current trusted authority, not shape validation.
 * A per-process map or assert-then-mutate alone cannot implement this contract. */
export interface PersonVmAdmissionPort {
  readonly participant: PersonVmAdmissionParticipant;
  observe(
    binding: PersonVmBinding,
    signal: AbortSignal,
  ): Promise<PersonVmAdmissionObservation>;
  subscribe(
    binding: PersonVmBinding,
    signal: AbortSignal,
  ): Promise<PersonVmAdmissionSubscription>;
  /** CAS at the shared admission boundary; retry the same exact lease after
   * lost ACK. Does not cancel/drain active work or wait for queued to reach 0.
   * New requests defer without reporting a freeze error to the requester. */
  freeze(
    lease: PersonVmAdmissionLease,
    signal: AbortSignal,
  ): Promise<PersonVmAdmissionObservation>;
  /** Recheck the exact authoritative lease and this participant's frozen ACK.
   * A read by itself is not the atomic stop commit; use authority.withLease. */
  assertFrozen(
    lease: PersonVmAdmissionLease,
    signal: AbortSignal,
  ): Promise<void>;
  /** Release ONLY the exact holder. A late/stale thaw cannot open a new freeze.
   * One participant's release only records deferred demand. Before actual wake/boot,
   * instance/epoch advance or dispatch, the model host must confirm BOTH
   * participants released this exact freeze by ACK/authoritative reconciliation.
   * Lost/late ACKs require exact old-lease reconciliation; superseded is NOT
   * release evidence. No cross-epoch cleanup exception. Then authority.wake
   * must reauthorize the current, complete execution binding. */
  thaw(
    lease: PersonVmAdmissionLease,
    signal: AbortSignal,
  ): Promise<'released' | 'already-released' | 'superseded'>;
}

/** PROPOSED model-host authority, shared by every participating host. Owner
 * issuance, durable fencing/recovery and the linearization mechanism are NOT
 * implemented here. Participants never query private VM tables themselves. */
export interface PersonVmAdmissionAuthorityPort {
  /** Current host owner + complete binding/version, independent of running
   * phase. starting MUST NOT call the running-only assertCurrentBinding. */
  assertLease(
    lease: PersonVmAdmissionLease,
    signal: AbortSignal,
  ): Promise<void>;
  /** Compare AND execute under the same per-person admission/version fence.
   * Used for participant CAS and final recheck + stop/confirmation; freeze/thaw
   * are invoked outside the final callback, assertFrozen inside it. No nested
   * withLease for the same person. The fence lasts through actual callback and
   * child-operation settlement, even on abort; losing it cannot enable another
   * owner until the old operation is reliably fenced. Reads alone are weaker. */
  withLease<T>(
    lease: PersonVmAdmissionLease,
    operation: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T>;
  /** Called by the participant holding deferred demand, never by guest input.
   * An early call records demand only: the host must first confirm release of
   * BOTH participants for the same exact old freeze before boot, instance/epoch
   * advance or dispatch. Then reauthorize context/person/organization, serialize
   * wake and return the current full binding ONLY after authenticated/editorReady/
   * canSend all hold. Settle the old freeze before a new generation; never
   * relabel old execution envelopes or treat superseded as release evidence. */
  wake(
    context: RequestContext,
    previousBinding: PersonVmBinding,
    signal: AbortSignal,
  ): Promise<PersonVmBinding>;
}

/** Existing instantaneous activity plus a proposed complete native projection.
 * Future enabled/armed reminders are NOT activeScheduleDeliveries. A missing
 * exact public delivery/execution/drain source is null + unknown, never zero.
 * Existing turn/approval and host hold protections remain mandatory. */
export type PersonVmNativeActivityObservation = Readonly<{
  activity: PersonVmActivity;
  activeScheduleDeliveries: number | null;
  coverage: PersonVmIdleCoverage;
}>;

/** PROPOSED native-runtime-owner producer. Must account for all person's roots,
 * public pending/waking work and changes between observations; otherwise emit
 * unknown. No private native gate or alternate Agent state machine is implied. */
export interface PersonVmNativeActivityPort {
  observe(
    binding: PersonVmBinding,
    signal: AbortSignal,
  ): Promise<PersonVmNativeActivityObservation>;
  subscribe(
    binding: PersonVmBinding,
    signal: AbortSignal,
  ): Promise<PersonVmAdmissionSubscription>;
}
