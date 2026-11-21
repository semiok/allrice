import type { RequestContext } from '@allrice/contracts';
import type { PersonVmBinding } from './contract.ts';
import type { PersonVmAdmissionParticipant } from './admission-contract.ts';

export const PERSON_VM_ADMISSION_BOUNDARY_VERSION = 1 as const;

/** HOST ONLY. A handle belongs to its issuing boundary/operation, not JSON.
 * The signal is canceled on caller cancellation, owner loss or revocation.
 * A deferred handle never acquires permission to run an old execution envelope. */
export type PersonVmAdmissionPermit = Readonly<{
  permitId: string;
  binding: PersonVmBinding;
  participant: PersonVmAdmissionParticipant;
  disposition: 'queued' | 'deferred';
  signal: AbortSignal;
}>;

/** Shared PG producer for BOTH participants; not a per-process gate map.
 * Enter before memory/8-slot/refresh waits or entry/native side effects.
 * Every owned wait/transport/transaction must run through queued/activate so
 * finish can cancel and JOIN actual work before releasing the durable permit. */
export interface PersonVmAdmissionBoundary {
  admit(
    context: RequestContext,
    binding: PersonVmBinding,
    input: {
      participant: PersonVmAdmissionParticipant;
      operationId: string;
    },
    signal: AbortSignal,
  ): Promise<PersonVmAdmissionPermit>;
  /** Own a pre-dispatch wait without changing an already admitted queued item
   * into deferred. The callback must settle all of its child operations. */
  queued<T>(
    permit: PersonVmAdmissionPermit,
    operation: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T>;
  /** Atomically activate the SAME admitted permit before calling operation.
   * No callback runs for deferred, stale binding, closing or revoked handles. */
  activate<T>(
    permit: PersonVmAdmissionPermit,
    operation: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T>;
  /** For deferred demand only: await BOTH exact old-freeze release ACKs, then
   * reauthorize and wake through the model host. Returns a current ready binding.
   * Finish the old permit and admit a NEW request with that binding; never
   * relabel or replay an old native execution envelope. */
  waitUntilReady(
    context: RequestContext,
    permit: PersonVmAdmissionPermit,
    signal: AbortSignal,
  ): Promise<PersonVmBinding>;
  /** Idempotent joined close: cancel and await every queued/active callback,
   * then release the durable permit. A failed join/DB write retains it as
   * unknown, never manufactures zero or automatically thaws a gate. */
  finish(permit: PersonVmAdmissionPermit): Promise<void>;
}
