import { ModelGatewayError } from './contract.ts';
import type { ModelCallBinding, ModelGatewayAdmission } from './contract.ts';

/** Consumer-local value, not a wire contract or a new person-vm API. */
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** Local Promise ownership only. Gate/permit/ACK/cursor authority stays in the
 * injected shared host. One activation owns the SAME real request, including
 * iterator shutdown, HTTP drain and the credential owner's complete transaction. */
export async function runGatewayAdmission<T>(
  admission: ModelGatewayAdmission,
  binding: ModelCallBinding,
  operationId: string,
  signal: AbortSignal,
  operation: (
    signal: AbortSignal,
    activate: () => Promise<void>,
  ) => Promise<Outcome<T>>,
): Promise<T> {
  const { boundary } = admission;
  const permit = await boundary.admit(
    binding.context,
    binding.vm,
    { participant: 'gateway', operationId },
    signal,
  );
  let work: Promise<Outcome<T>> | undefined;
  let activation: Promise<Outcome<T>> | undefined;
  let outcome: Outcome<T> | undefined;
  let failed = false;
  let failure: unknown;
  let cleanupFailed = false;
  let cleanupFailure: unknown;
  try {
    signal.throwIfAborted();
    if (permit.disposition === 'deferred') {
      // The host alone owns exact dual-release reconciliation and true ready.
      // Its VM result cannot reauthorize this immutable native call envelope.
      await boundary.waitUntilReady(binding.context, permit, signal);
      signal.throwIfAborted();
      throw new ModelGatewayError('EXECUTION_REBIND_REQUIRED');
    }
    outcome = await boundary.queued(
      permit,
      (queuedSignal) => {
        const activeCancellation = new AbortController();
        const workSignal = AbortSignal.any([
          signal,
          permit.signal,
          queuedSignal,
          activeCancellation.signal,
        ]);
        let entered: Promise<void>;
        const activate = () => {
          if (!activation) {
            let accept!: () => void;
            let reject!: (error: unknown) => void;
            entered = new Promise<void>((yes, no) => {
              accept = yes;
              reject = no;
            });
            activation = boundary.activate(
              permit,
              async (activeSignal) => {
                const cancel = () =>
                  activeCancellation.abort(activeSignal.reason);
                activeSignal.addEventListener('abort', cancel, { once: true });
                try {
                  if (activeSignal.aborted) cancel();
                  accept(); // The callback really entered; dispatch may proceed.
                  return await work!;
                } finally {
                  activeSignal.removeEventListener('abort', cancel);
                }
              },
              workSignal,
            );
            // Reject a blocked dispatch if the host refuses activation. This
            // handler also owns a rejection while the real work is unwinding.
            void activation.catch(reject);
          }
          return entered;
        };
        // Defer invocation one microtask so activate always sees this exact
        // real Promise. No synthetic never-settling work or completion signal.
        work = Promise.resolve().then(() => operation(workSignal, activate));
        return work;
      },
      signal,
    );
    await activation;
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    await Promise.allSettled([work, activation]);
    // c041d94c finish still cancels/joins its own resources after an entered
    // callback rejects. Its sticky unsafe proof retains the durable permit.
    try {
      await boundary.finish(permit);
    } catch (cleanupError) {
      cleanupFailed = true;
      cleanupFailure = cleanupError;
    }
  }
  // A boundary can reject its own listener cleanup AFTER work returned a
  // confirmed-join business failure. Keep that earlier outcome as well as both
  // callback/finish errors; never replace the original evidence in finally.
  const errors: unknown[] = outcome && !outcome.ok ? [outcome.error] : [];
  if (failed && !errors.includes(failure)) errors.push(failure);
  if (cleanupFailed) errors.push(cleanupFailure);
  if (cleanupFailed || (failed && errors.length > 1))
    throw new ModelGatewayError('LEDGER_UNAVAILABLE', {
      cause:
        errors.length === 1
          ? errors[0]
          : new AggregateError(errors, 'admission cleanup failed'),
    });
  if (failed) throw failure;
  const result = outcome!;
  if (!result.ok) throw result.error;
  return result.value;
}
