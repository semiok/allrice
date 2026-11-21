import { ModelGatewayError } from './contract.ts';
import type { ModelCallBinding, ModelGatewayAdmission } from './contract.ts';

/** Local Promise ownership only. Gate/permit/ACK/cursor authority stays in the
 * injected shared host. One activation owns the SAME real request, including
 * iterator shutdown, HTTP drain and the credential owner's complete transaction. */
export async function runGatewayAdmission(
  admission: ModelGatewayAdmission,
  binding: ModelCallBinding,
  operationId: string,
  signal: AbortSignal,
  operation: (
    signal: AbortSignal,
    activate: () => Promise<void>,
  ) => Promise<void>,
): Promise<void> {
  const { boundary } = admission;
  const permit = await boundary.admit(
    binding.context,
    binding.vm,
    { participant: 'gateway', operationId },
    signal,
  );
  let work: Promise<void> | undefined;
  let activation: Promise<void> | undefined;
  let unknownJoin = false;
  let failed = false;
  let failure: unknown;
  try {
    signal.throwIfAborted();
    if (permit.disposition === 'deferred') {
      // The host alone owns exact dual-release reconciliation and true ready.
      // Its VM result cannot reauthorize this immutable native call envelope.
      await boundary.waitUntilReady(binding.context, permit, signal);
      signal.throwIfAborted();
      throw new ModelGatewayError('EXECUTION_REBIND_REQUIRED');
    }
    await boundary.queued(
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
                  await work;
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
        work = Promise.resolve()
          .then(() => operation(workSignal, activate))
          .catch((error: unknown) => {
            // The caller handles ordinary provider failures after confirmed
            // join; only an unconfirmed actual drain is allowed to escape.
            unknownJoin = true;
            throw error;
          });
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
    // 8115ae61 finish ignores callback rejection. Until the producer supplies
    // an explicit unknown-join recovery contract, retain the durable permit.
    // All local callbacks still settle; a rejected Promise is never fake idle.
    if (!unknownJoin) {
      try {
        await boundary.finish(permit);
      } catch (cleanupError) {
        failure = new ModelGatewayError('LEDGER_UNAVAILABLE', {
          cause: failed
            ? new AggregateError(
                [failure, cleanupError],
                'admission cleanup failed',
              )
            : cleanupError,
        });
        failed = true;
      }
    }
  }
  if (failed) throw failure;
}
