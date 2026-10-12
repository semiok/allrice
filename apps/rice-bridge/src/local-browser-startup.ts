/** Playwright page/context setup can outlive its native child. A pending
 * channel response must not prevent the owner from running native cleanup. */
export async function awaitLocalBrowserStartup<T>(
  initialize: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const abort = new AbortController();
  const cancel = () => abort.abort(signal?.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(
    () => abort.abort(Error('LOCAL_BROWSER_STARTUP_TIMEOUT')),
    15_000,
  );
  let reject!: (reason: unknown) => void;
  const canceled = new Promise<never>((_resolve, failure) => {
    reject = failure;
  });
  const interrupted = () => reject(abort.signal.reason);
  abort.signal.addEventListener('abort', interrupted, { once: true });
  try {
    abort.signal.throwIfAborted();
    return await Promise.race([initialize(abort.signal), canceled]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    abort.signal.removeEventListener('abort', interrupted);
  }
}
