/* global AbortController */

// Transport-only propagation of the caller's AbortSignal. No deadline, retry,
// durable state or detached work: cancellation joins the original operation.
export function createWebCallScope() {
  const active = new Map();
  return {
    run(key, operation) {
      if (active.has(key)) throw Error('WEB_CALL_ALREADY_ACTIVE');
      const controller = new AbortController();
      const done = Promise.resolve()
        .then(() => operation(controller.signal))
        .finally(() => active.delete(key));
      active.set(key, { controller, done });
      return done;
    },
    async cancel(key) {
      const call = active.get(key);
      if (call) {
        call.controller.abort();
        // The original request owns the operation error. This reply confirms
        // only that its actual work has settled, not that it succeeded.
        await call.done.catch(() => {});
      }
      return { settled: true };
    },
  };
}

export async function requestCancellableWeb(
  request,
  method,
  cancelMethod,
  params,
  signal,
) {
  signal?.throwIfAborted();
  // Do NOT pass the signal to DSH transport.request: that only abandons the
  // waiting RPC and cannot establish that remote HTTP work has stopped.
  const pending = request(method, params);
  let cancellation;
  const cancel = () => {
    cancellation ??= request(cancelMethod, params).then((receipt) => {
      if (receipt?.settled !== true) throw Error('WEB_CANCEL_UNCONFIRMED');
    });
    // Observed again below after joining pending; prevent a premature
    // unhandled rejection if the transport fails before the HTTP settles.
    void cancellation.catch(() => {});
  };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    // DSH owns the outcome of a successfully joined, canceled call. Preserve
    // actual remote failures; do not replace success with a raw abort reason.
    return await pending;
  } finally {
    signal?.removeEventListener('abort', cancel);
    await cancellation;
  }
}
