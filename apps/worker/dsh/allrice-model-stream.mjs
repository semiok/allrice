/* global clearTimeout, setTimeout */
import { LlmError } from '@deepseek-ai/dsh-llm';

// Match pinned DSH's provider idle timeout. Its watchdog aborts the provider,
// but awaits iterator.next()/return(); an unresponsive transport can ignore it.
// Bound that wait without replacing the native model loop, retry or accounting.
export async function* boundedModelStream(
  stream,
  { signal, idleMs = 300_000, noticeMs = 60_000, onWait = () => {} } = {},
) {
  const iterator = stream[Symbol.asyncIterator]();
  let exhausted = false;
  try {
    for (;;) {
      let timer, notice, abort;
      let waiting = false;
      let result;
      try {
        if (signal?.aborted)
          throw new LlmError('Model request canceled', 'ABORTED');
        const stopped = new Promise((_, reject) => {
          abort = () =>
            reject(new LlmError('Model request canceled', 'ABORTED'));
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) return abort();
          notice = setTimeout(() => {
            waiting = true;
            onWait('started');
          }, noticeMs);
          timer = setTimeout(
            () => reject(new LlmError('Model stream idle timeout', 'TIMEOUT')),
            idleMs,
          );
        });
        result = await Promise.race([iterator.next(), stopped]);
      } catch (error) {
        if (waiting) {
          onWait('failed');
          waiting = false;
        }
        throw error;
      } finally {
        clearTimeout(timer);
        clearTimeout(notice);
        signal?.removeEventListener('abort', abort);
        if (waiting) onWait('completed');
      }
      if (result.done) {
        exhausted = true;
        return;
      }
      yield result.value;
    }
  } finally {
    // A late provider result must never re-enter the agent loop. The owning
    // runtime is drained/dropped on failure; do not hang again during teardown.
    if (!exhausted)
      void Promise.resolve()
        .then(() => iterator.return?.())
        .catch(() => {});
  }
}
