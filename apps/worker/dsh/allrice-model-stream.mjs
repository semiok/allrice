/* global clearTimeout, setTimeout */
import { LlmError } from '@deepseek-ai/dsh-llm';
import { types } from 'node:util';

const recoveryReceipts = new WeakMap();
const idleErrors = new WeakSet();
function ownData(value, key) {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
export const modelStreamRecoveryReceipt = (error) =>
  recoveryReceipts.get(error);

// Match pinned DSH's provider idle timeout. Its watchdog aborts the provider,
// but awaits iterator.next()/return(); an unresponsive transport can ignore it.
// Bound that wait without replacing the native model loop, retry or accounting.
export async function* boundedModelStream(
  stream,
  {
    signal,
    idleMs = 300_000,
    noticeMs = 60_000,
    closeWaitMs = 2_000,
    onWait = () => {},
    onDiagnostic = () => {},
    transport,
  } = {},
) {
  const iterator = stream[Symbol.asyncIterator]();
  let exhausted = false;
  let closing;
  let lastRead;
  let lastChunkAt = Date.now();
  let finishSeen = false;
  const run = (fn) => (transport ? transport.run(fn) : fn());
  const close = () =>
    (closing ??= Promise.resolve().then(() => run(() => iterator.return?.())));
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
          timer = setTimeout(() => {
            const error = new LlmError('Model stream idle timeout', 'TIMEOUT');
            idleErrors.add(error);
            reject(error);
          }, idleMs);
        });
        lastRead = run(() => iterator.next());
        result = await Promise.race([lastRead, stopped]);
      } catch (error) {
        if (waiting) {
          onWait('failed');
          waiting = false;
        }
        if (transport && idleErrors.has(error) && !signal?.aborted) {
          const diagnostic = transport.snapshot(lastChunkAt);
          transport.stop();
          // Abort is a request, not proof of shutdown. Both the outstanding
          // read AND the iterator must settle, and the owned transport must be
          // closed, before native recovery can acquire another admission.
          let deadline;
          const drained =
            diagnostic.transport === 'unobserved'
              ? false
              : await Promise.race([
                  Promise.all([
                    Promise.resolve(lastRead).catch(() => {}),
                    close(),
                  ]).then(
                    () => true,
                    () => false,
                  ),
                  new Promise((resolve) => {
                    deadline = setTimeout(() => resolve(false), closeWaitMs);
                  }),
                ]);
          clearTimeout(deadline);
          const confirmed =
            drained && transport.locallyClosed() && !signal?.aborted;
          const receipt = {
            ...diagnostic,
            localCloseConfirmed: confirmed,
            finishSeen,
          };
          recoveryReceipts.set(error, receipt);
          onDiagnostic(receipt);
          if (signal?.aborted)
            throw new LlmError('Model request canceled', 'ABORTED');
        }
        throw error;
      } finally {
        clearTimeout(timer);
        clearTimeout(notice);
        signal?.removeEventListener('abort', abort);
        if (waiting)
          onWait(
            result?.value?.type === 'finish' &&
              ['error', 'aborted'].includes(result.value.reason?.kind)
              ? 'failed'
              : 'completed',
          );
      }
      if (result.done) {
        exhausted = true;
        return;
      }
      if (result.value?.type === 'finish') {
        finishSeen = true;
        if (
          transport &&
          ['TIMEOUT', 'TRANSPORT'].includes(
            ownData(
              ownData(ownData(result.value, 'reason'), 'failure'),
              'code',
            ),
          )
        )
          onDiagnostic({
            ...transport.snapshot(lastChunkAt),
            localCloseConfirmed: false,
            finishSeen,
          });
      }
      lastChunkAt = Date.now();
      yield result.value;
    }
  } finally {
    // A late provider result must never re-enter the agent loop. The owning
    // runtime is drained/dropped on failure; do not hang again during teardown.
    if (!exhausted) {
      transport?.stop();
      void close().catch(() => {});
    }
  }
}
