import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ModelGatewayError } from './contract.ts';
import type {
  ModelCallBinding,
  ModelGatewayStore,
  GatewayProvider,
  ModelAttemptReceipt,
} from './contract.ts';
import { unknownUsage, WireUsageObserver } from './usage.ts';

type Fetch = typeof globalThis.fetch;
type FetchScope = {
  fetch(
    original: Fetch,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response>;
};
const scopes = new AsyncLocalStorage<FetchScope>();
let users = 0;
let original: Fetch;
let wrapper: Fetch;
let deactivate: () => void;

/** Explicitly installed by an opt-in host gateway, never at module import.
 * Shared scopes allow multiple gateway instances without stacking meters. */
export function installScopedFetch(): () => void {
  if (users++ === 0) {
    original = globalThis.fetch;
    const fallback = original;
    let enabled = true;
    deactivate = () => {
      enabled = false;
    };
    wrapper = (input, init) => {
      const scope = enabled ? scopes.getStore() : undefined;
      return scope ? scope.fetch(fallback, input, init) : fallback(input, init);
    };
    globalThis.fetch = wrapper;
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (--users === 0) {
      deactivate();
      if (globalThis.fetch === wrapper) globalThis.fetch = original;
    }
  };
}

export function createMeteredTransport(options: {
  binding: ModelCallBinding;
  callId: string;
  ownerId: string;
  store: ModelGatewayStore;
  provider: GatewayProvider;
  signal: AbortSignal;
  assertCurrent(signal: AbortSignal): Promise<void>;
}) {
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  const pending = new Set<Promise<void>>();
  const cancellations = new Set<() => Promise<void>>();
  let ledgerFailure: unknown;
  let stopped = false;
  const scope: FetchScope = {
    async fetch(nativeFetch, input, init) {
      if (stopped) throw new ModelGatewayError('ADMISSION_CLOSED');
      signal.throwIfAborted();
      const classification = options.provider.classify(input, init);
      if (!classification) throw new ModelGatewayError('UNCLASSIFIED_UPSTREAM');
      const incoming =
        init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const requestSignal = incoming
        ? AbortSignal.any([signal, incoming])
        : signal;
      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      pending.add(done);
      const attempt = {
        id: randomUUID(),
        callId: options.callId,
        ownerId: options.ownerId,
        personId: options.binding.vm.personId,
        ...classification,
      };
      const observer = new WireUsageObserver(classification.protocol);
      let started = false;
      let dispatched = false;
      let status: number | null = null;
      let completed: Promise<void> | undefined;
      let closeUnconfirmed = false;
      const finish = (outcome: ModelAttemptReceipt['outcome']) =>
        (completed ??= (async () => {
          try {
            if (started && !closeUnconfirmed)
              await options.store.finishAttempt({
                ...attempt,
                dispatchObserved: dispatched,
                httpStatus: status,
                terminal: observer.terminal,
                outcome,
                usage:
                  classification.kind === 'model'
                    ? observer.usage
                    : unknownUsage(),
              });
          } catch (error) {
            ledgerFailure ??= error;
            throw error;
          } finally {
            pending.delete(done);
            resolveDone();
          }
        })());
      try {
        // Listen first, then atomically try admission: a release between those
        // operations is remembered, so a waiter cannot lose its wakeup.
        const watch =
          classification.kind === 'model'
            ? await options.store.watchCapacity(attempt.personId, requestSignal)
            : null;
        try {
          for (;;) {
            requestSignal.throwIfAborted();
            await options.assertCurrent(requestSignal);
            if (await options.store.tryStartAttempt(attempt)) {
              started = true;
              break;
            }
            if (!watch) throw new ModelGatewayError('LEDGER_UNAVAILABLE');
            await watch.wait();
          }
        } finally {
          await watch?.close();
        }
        // Current epoch/membership may have changed while the intent committed.
        await options.assertCurrent(requestSignal);
        requestSignal.throwIfAborted();
        dispatched = true;
        // Never follow redirects: fetch otherwise hides additional actual HTTP
        // requests and can forward credentials outside the approved endpoint.
        const response = await nativeFetch(input, {
          ...init,
          redirect: 'manual',
          signal: requestSignal,
        });
        status = response.status;
        if (!response.body) {
          await finish('closed');
          return response;
        }
        const reader = response.body.getReader();
        let canceled: Promise<void> | undefined;
        let target: ReadableStreamDefaultController<Uint8Array> | undefined;
        const cleanup = () => {
          requestSignal.removeEventListener('abort', onAbort);
          cancellations.delete(cancel);
        };
        const cancel = () =>
          (canceled ??= (async () => {
            // reader.cancel is awaited; an abort request alone never releases a slot.
            try {
              await reader.cancel(requestSignal.reason);
            } catch (error) {
              // A failed close is unknown. Leave the durable intent/slot for a
              // trusted dead-transport reconciliation, never count it as free.
              ledgerFailure ??= error;
              closeUnconfirmed = true;
              cleanup();
              pending.delete(done);
              resolveDone();
              throw error;
            }
            // Native pi-ai closes its private consumer signal after it has parsed
            // a terminal frame, sometimes before reading HTTP EOF. That is a
            // confirmed transport close, not a user cancellation. The host's
            // actual client/revoke signal remains authoritative for cancellation.
            cleanup();
            await finish(
              options.signal.aborted
                ? 'canceled'
                : observer.terminal !== null
                  ? 'closed'
                  : requestSignal.aborted
                    ? 'canceled'
                    : 'failed',
            );
          })());
        const onAbort = () => {
          void cancel().then(
            () => {
              try {
                target?.error(requestSignal.reason);
              } catch {
                /* already settled */
              }
            },
            () => {
              try {
                target?.error(new ModelGatewayError('LEDGER_UNAVAILABLE'));
              } catch {
                /* settled */
              }
            },
          );
        };
        cancellations.add(cancel);
        requestSignal.addEventListener('abort', onAbort, { once: true });
        const body = new ReadableStream<Uint8Array>(
          {
            start(value) {
              target = value;
              if (requestSignal.aborted) onAbort();
            },
            async pull(value) {
              try {
                const result = await reader.read();
                if (requestSignal.aborted) {
                  await cancel();
                  value.error(requestSignal.reason);
                } else if (result.done) {
                  cleanup();
                  await finish('closed');
                  value.close();
                } else {
                  observer.push(result.value);
                  value.enqueue(result.value);
                }
              } catch (error) {
                cleanup();
                try {
                  await finish(requestSignal.aborted ? 'canceled' : 'failed');
                } catch {
                  value.error(new ModelGatewayError('LEDGER_UNAVAILABLE'));
                  return;
                }
                value.error(error);
              }
            },
            cancel,
          },
          { highWaterMark: 0 },
        );
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (error) {
        await finish(requestSignal.aborted ? 'canceled' : 'failed');
        throw error;
      }
    },
  };
  return {
    run<T>(callback: () => T): T {
      return scopes.run(scope, callback);
    },
    async drain() {
      stopped = true;
      controller.abort(new Error('model_gateway_transport_closed'));
      await Promise.allSettled([...cancellations].map((cancel) => cancel()));
      await Promise.all([...pending]);
      if (ledgerFailure)
        throw new ModelGatewayError('LEDGER_UNAVAILABLE', {
          cause: ledgerFailure,
        });
    },
  };
}
