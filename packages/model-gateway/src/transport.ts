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
import {
  installNativeCloseObserver,
  observeNativeClose,
} from './native-close.ts';

type Fetch = typeof globalThis.fetch;
type FetchScope = {
  authTransaction<T>(operation: () => Promise<T>): Promise<T>;
  fetch(
    original: Fetch,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response>;
};
const scopes = new AsyncLocalStorage<FetchScope>();
const authTransactions = new AsyncLocalStorage<symbol>();
let users = 0;
let original: Fetch;
let wrapper: Fetch;
let deactivate: () => void;

/** The host credential owner wraps its existing public modify/modifyRecord
 * operation, including durable persistence. No credential enters the gateway.
 * Native refresh may outlive its canceled caller; the gateway must await that
 * whole transaction before detaching its meter or disposing the host loader. */
export function withGatewayAuthTransaction<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const scope = scopes.getStore();
  return scope ? scope.authTransaction(operation) : operation();
}

/** Explicitly installed by an opt-in host gateway, never at module import.
 * Shared scopes allow multiple gateway instances without stacking meters. */
export function installScopedFetch(): () => void {
  if (users++ === 0) {
    original = globalThis.fetch;
    const fallback = original;
    const disposeCloseObserver = installNativeCloseObserver();
    let enabled = true;
    deactivate = () => {
      enabled = false;
      disposeCloseObserver();
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
  const activeAuth = new Set<symbol>();
  let ledgerFailure: unknown;
  let stopped = false;
  const scope: FetchScope = {
    async authTransaction(operation) {
      if (stopped) throw new ModelGatewayError('ADMISSION_CLOSED');
      signal.throwIfAborted();
      const token = Symbol();
      activeAuth.add(token);
      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      pending.add(done);
      try {
        return await authTransactions.run(token, operation);
      } finally {
        activeAuth.delete(token);
        pending.delete(done);
        resolveDone();
      }
    },
    async fetch(nativeFetch, input, init) {
      const classification = options.provider.classify(input, init);
      if (!classification) throw new ModelGatewayError('UNCLASSIFIED_UPSTREAM');
      const refreshing = classification.kind === 'auth-refresh';
      if (refreshing) {
        const token = authTransactions.getStore();
        if (!token || !activeAuth.has(token))
          throw new ModelGatewayError('AUTH_TRANSACTION_REQUIRED');
      } else {
        if (stopped) throw new ModelGatewayError('ADMISSION_CLOSED');
        signal.throwIfAborted();
      }
      const incoming =
        init?.signal ?? (input instanceof Request ? input.signal : undefined);
      // pi-ai supplies its own independent 15s timeout after refresh starts.
      // Never merge model/client/revocation/close cancellation into it.
      const requestSignal = refreshing
        ? (incoming ??
          AbortSignal.abort(new ModelGatewayError('AUTH_TRANSACTION_REQUIRED')))
        : incoming
          ? AbortSignal.any([signal, incoming])
          : signal;
      const method = (
        init?.method ?? (input instanceof Request ? input.method : 'GET')
      ).toUpperCase();
      if (method === 'GET' || method === 'HEAD')
        throw new ModelGatewayError('UNSUPPORTED_UPSTREAM');
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
      const nativeClose = observeNativeClose();
      let started = false;
      let dispatched = false;
      let status: number | null = null;
      let completed: Promise<void> | undefined;
      const finish = (outcome: ModelAttemptReceipt['outcome']) =>
        (completed ??= (async () => {
          try {
            if (started)
              await options.store.finishAttempt({
                ...attempt,
                dispatchObserved: dispatched,
                httpStatus: status,
                terminal: observer.terminal,
                terminalReason: observer.terminalReason,
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
            nativeClose.dispose();
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
            if (!refreshing) await options.assertCurrent(requestSignal);
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
        if (!refreshing) await options.assertCurrent(requestSignal);
        requestSignal.throwIfAborted();
        // Construct only after admission and durable intent. A replayable body
        // (including null) lets native Fetch resend 421 inside one call. Use the
        // public Request's exact bytes/headers as a one-shot stream, without tee.
        const requestInit: RequestInit & { duplex: 'half' } = {
          ...init,
          signal: requestSignal,
          redirect: 'manual',
          duplex: 'half',
        };
        const request = new Request(input, requestInit);
        const dispatchInit: RequestInit & { duplex: 'half' } = {
          body:
            request.body ??
            new ReadableStream({
              start(value) {
                value.close();
              },
            }),
          duplex: 'half',
        };
        dispatched = true;
        // Redirects are disabled in request; hidden 421 replay is disabled by
        // the one-shot body. Each later SDK fetch gets its own durable attempt.
        const response = await nativeClose.run(() =>
          nativeFetch(request, dispatchInit),
        );
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
              if (await nativeClose.confirmed()) {
                cleanup();
                await finish(
                  !refreshing && options.signal.aborted ? 'canceled' : 'closed',
                );
                return;
              }
              // Neither cancel rejection nor an errored reader proves closure.
              // Preserve observed wire facts, retaining the exact durable slot.
              ledgerFailure ??= error;
              cleanup();
              await finish('unknown');
              throw error;
            }
            // Native pi-ai closes its private consumer signal after it has parsed
            // a terminal frame, sometimes before reading HTTP EOF. That is a
            // confirmed transport close, not a user cancellation. The host's
            // actual client/revoke signal remains authoritative for cancellation.
            cleanup();
            await finish(
              !refreshing && options.signal.aborted
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
        if (!refreshing) cancellations.add(cancel);
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
                try {
                  // Read failure and signal abort can race. Both must await
                  // the same actual close confirmation before finalizing facts.
                  await cancel();
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
