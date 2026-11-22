import type { RequestContext } from '@allrice/contracts';
import { DataAccessError } from './data.ts';
import {
  PersonVmError,
  type PersonVmAdmissionBoundary,
  type PersonVmAdmissionPermit,
  type PersonVmAdmissionPort,
  type PersonVmBinding,
} from '@allrice/person-vm/admission';

/** Preparation only: production must inject the final reviewed producer and
 * its entry participant from the same model-host composition. No SQL here. */
export type DEntryAdmissionPorts = Readonly<{
  boundary: PersonVmAdmissionBoundary;
  participant: PersonVmAdmissionPort;
}>;

/** A real operation owner supplies this handle INSIDE the admitted callback.
 * run/close cover partial initialization and every managed child/transport.
 * close triggers cancellation and returns the actual joined-close Promise;
 * AbortSignal or one iterator.return is not a substitute. Acquisition failure
 * before a handle exists remains an unknown callback rejection. */
export type DEntryOwnedActivity<T> = Readonly<{
  run(signal: AbortSignal): Promise<T>;
  close(): Promise<void>;
}>;

/** Host-only current owner of the immutable full business envelope. The entry
 * cannot manufacture Run/call/profile/release/route facts from browser JSON.
 * These checks include current login, employee, thread/root and execution;
 * they never create a Run/call, change a claim, or relabel an old envelope. */
export type DEntryAdmissionOwner = Readonly<{
  context: RequestContext;
  binding: PersonVmBinding;
  operationId: string;
  revoked: AbortSignal;
  assertCurrent(signal: AbortSignal): Promise<void>;
  assertUndispatched(signal: AbortSignal): Promise<void>;
}>;

type Outcome<T> =
  Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: unknown }>;
type Acquire<T> = (signal: AbortSignal) => DEntryOwnedActivity<T>;

function sameBinding(a: PersonVmBinding, b: PersonVmBinding) {
  return (
    a.personId === b.personId &&
    a.organizationId === b.organizationId &&
    a.vmId === b.vmId &&
    a.instanceId === b.instanceId &&
    a.leaseEpoch === b.leaseEpoch
  );
}

/** Fulfil a business outcome ONLY after the real owner has joined. Unknown
 * acquire/close failures reject this callback and must remain sticky unsafe in
 * the final producer, even if an outer callback later catches that rejection. */
async function ownedOutcome<T>(
  acquire: Acquire<T>,
  owner: DEntryAdmissionOwner,
  signal: AbortSignal,
): Promise<Outcome<T>> {
  signal.throwIfAborted();
  await owner.assertCurrent(signal);
  signal.throwIfAborted();
  const activity = acquire(signal); // Never classify a missing handle as joined.
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= Promise.resolve().then(() => activity.close()));
  const cancel = () => {
    void close().catch(() => {}); // Awaited below; never becomes a safe outcome.
  };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  let outcome: Outcome<T>;
  try {
    try {
      signal.throwIfAborted();
      outcome = { ok: true, value: await activity.run(signal) };
      signal.throwIfAborted();
    } catch (error) {
      outcome = { ok: false, error };
    }
    // Outside the business catch: a rejected close must reject the callback.
    try {
      await close();
    } catch (error) {
      if (!outcome.ok || signal.aborted) {
        const original = outcome.ok ? signal.reason : outcome.error;
        throw new AggregateError(
          [original, error],
          'D entry owner cleanup unknown',
          { cause: original },
        );
      }
      throw error;
    }
    if (outcome.ok && signal.aborted)
      return { ok: false, error: signal.reason };
    return outcome;
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

/** Own one complete connection/typing/prewarm operation, including its actual
 * children. This is not a transport/resolver implementation or cold boot API.
 * Requires the reviewed c041 producer; this contract slice installs no host. */
export async function runDEntryAdmittedActivity<T>(
  input: {
    ports: DEntryAdmissionPorts;
    owner: DEntryAdmissionOwner;
    signal: AbortSignal;
    queued?: Acquire<void>;
  },
  acquire: Acquire<T>,
): Promise<T> {
  const { boundary, participant } = input.ports;
  const { owner } = input;
  const binding = Object.freeze({ ...owner.binding });
  const context = structuredClone(owner.context);
  if (
    participant.participant !== 'entry' ||
    !owner.operationId ||
    context.actor.type !== 'user' ||
    context.actor.id !== binding.personId ||
    context.organizationId !== binding.organizationId
  )
    throw new DataAccessError('authorization_denied');
  // This root intentionally excludes every old permit's canceled signal.
  const root = AbortSignal.any([input.signal, owner.revoked]);
  let permit: PersonVmAdmissionPermit | undefined;
  let outcome: Outcome<T> | undefined;
  let failure: unknown;
  let failed = false;
  let cleanupFailure: unknown;
  let cleanupFailed = false;
  try {
    root.throwIfAborted();
    await owner.assertCurrent(root);
    const admit = () =>
      boundary.admit(
        context,
        binding,
        { participant: 'entry', operationId: owner.operationId },
        root,
      );
    permit = await admit();
    while (permit.disposition === 'deferred') {
      const ready = await boundary.waitUntilReady(context, permit, root);
      await boundary.finish(permit);
      permit = undefined;
      root.throwIfAborted();
      if (!sameBinding(ready, binding)) throw new PersonVmError('LEASE_LOST');
      await owner.assertCurrent(root);
      await owner.assertUndispatched(root);
      permit = await admit();
    }
    if (input.queued) {
      const queued = await boundary.queued(
        permit,
        (signal) => ownedOutcome(input.queued!, owner, signal),
        root,
      );
      if (!queued.ok) throw queued.error; // Outside the fulfilled callback.
    }
    outcome = await boundary.activate(
      permit,
      (signal) => ownedOutcome(acquire, owner, signal),
      root,
    );
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    if (permit) {
      try {
        await boundary.finish(permit);
      } catch (error) {
        cleanupFailed = true;
        cleanupFailure = error;
      }
    }
  }
  if (cleanupFailed) {
    if (failed || outcome?.ok === false) {
      const original = failed
        ? failure
        : outcome?.ok === false
          ? outcome.error
          : undefined;
      throw new AggregateError(
        [original, cleanupFailure],
        'D entry cleanup unknown',
        {
          cause: original,
        },
      );
    }
    throw cleanupFailure;
  }
  if (failed) throw failure;
  if (!outcome) throw new PersonVmError('CLEANUP_INCOMPLETE');
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
