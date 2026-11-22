import { createHash } from 'node:crypto';

/** Shared owner stream. The caller supplies the exact immutable pin and live
 * ACL recheck; this helper does not establish identity or issue a grant. */
export function createAuthorizedFileResource(options: {
  checksum: string;
  sizeBytes: number;
  signal: AbortSignal;
  recheck(signal: AbortSignal): Promise<unknown>;
  openSource(signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
  changed(): Error;
}) {
  const signal = options.signal;
  return async function open(openSignal: AbortSignal) {
    const stopped = new AbortController();
    const transferSignal = AbortSignal.any([
      signal,
      openSignal,
      stopped.signal,
    ]);
    await options.recheck(transferSignal);
    const stream = await options.openSource(transferSignal);
    try {
      await options.recheck(transferSignal);
    } catch (error) {
      try {
        await stream.cancel(error);
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          'Deliverable stream cleanup failed',
          { cause: error },
        );
      }
      throw error;
    }
    const reader = stream.getReader();
    const hash = createHash('sha256');
    let size = 0;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let work: Promise<boolean> | undefined;
    let consumerCanceled = false;
    let termination:
      Promise<{ error: unknown; cleanupFailed: boolean }> | undefined;
    const terminate = (
      reason: unknown,
      kind: 'complete' | 'error' | 'cancel',
    ) => {
      if (termination) return termination;
      transferSignal.removeEventListener('abort', abort);
      // Join only the I/O body, never pull's termination continuation:
      // otherwise a pull failure and this join would wait on each other.
      const pending = work;
      termination = Promise.resolve().then(async () => {
        const [reading, canceling] = await Promise.allSettled([
          pending,
          kind === 'complete'
            ? undefined
            : Promise.resolve().then(() => reader.cancel(reason)),
        ]);
        const failures: unknown[] = [];
        if (
          reading.status === 'rejected' &&
          reading.reason !== reason &&
          reading.reason !== transferSignal.reason
        )
          failures.push(reading.reason);
        if (canceling.status === 'rejected') failures.push(canceling.reason);
        try {
          reader.releaseLock();
        } catch (error) {
          failures.push(error);
        }
        const error = failures.length
          ? new AggregateError(
              [reason, ...failures],
              'Deliverable stream cleanup failed',
              { cause: reason },
            )
          : reason;
        // Native consumer cancellation closes its stream before invoking
        // cancel. Its returned Promise, rather than closed, proves join.
        if (!consumerCanceled) {
          if (kind === 'complete' && !failures.length) controller.close();
          else controller.error(error);
        }
        return { error, cleanupFailed: failures.length > 0 };
      });
      // The owner API has no SQL cancellation. Stop the next operation,
      // but wait for any already entered owner Promise above to settle.
      if (kind !== 'complete') stopped.abort(reason);
      return termination;
    };
    const abort = () => {
      // terminate records cleanup failures in the outer stream's error;
      // its always-fulfilled outcome also serves the consumer cancel path.
      void terminate(transferSignal.reason, 'error');
    };
    return new ReadableStream<Uint8Array>(
      {
        start(value) {
          controller = value;
          transferSignal.addEventListener('abort', abort, { once: true });
          if (transferSignal.aborted) abort();
        },
        pull() {
          if (termination) return termination.then(() => {});
          // Register before executing even a synchronous qualification
          // callback, which may itself trigger cancellation.
          const reading = Promise.resolve().then(async () => {
            await options.recheck(transferSignal);
            const chunk = await reader.read();
            await options.recheck(transferSignal);
            if (chunk.done) {
              if (
                size !== options.sizeBytes ||
                `sha256:${hash.digest('hex')}` !== options.checksum
              )
                throw options.changed();
              return true;
            }
            size += chunk.value.byteLength;
            if (size > options.sizeBytes) throw options.changed();
            hash.update(chunk.value);
            controller.enqueue(chunk.value);
            return false;
          });
          work = reading;
          return reading.then(
            (complete) => {
              if (work === reading) work = undefined;
              if (complete)
                return terminate(undefined, 'complete').then(() => {});
            },
            (error: unknown) => {
              if (work === reading) work = undefined;
              return terminate(error, 'error').then(() => {});
            },
          );
        },
        async cancel(reason) {
          consumerCanceled = true;
          const result = await terminate(reason, 'cancel');
          if (result.cleanupFailed) throw result.error;
        },
      },
      { highWaterMark: 0 },
    );
  };
}
