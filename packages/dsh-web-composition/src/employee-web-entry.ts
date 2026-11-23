import { AppWebEntry } from '@deepseek-ai/dsh-client-web';

export interface EmployeeWebEntryWork {
  /** The caller must already own the real runtime inputs. This callback only
   * applies them through the public injection interpreter in this document. */
  applyRequiredInjections(signal: AbortSignal): Promise<void>;
  /** Abort has already fenced new work. Join/release this document's actual
   * transport, owner and references; never report a timeout as cleanup. */
  cleanup(): Promise<void>;
}

export type EmployeeWebEntryStart =
  | { state: 'ready' }
  | { state: 'cancelled' }
  | { state: 'failed'; reason: unknown };
export type EmployeeWebEntryClose =
  { state: 'closed' } | { state: 'unknown'; reason: unknown };

let used = false;

/** One UI root in one native document. This is not an identity resolver or a
 * Host/Agent lifecycle. The product document currently refuses execution until
 * its real principal and unified profile carrier are delivered. */
export function startEmployeeWebEntry(
  container: HTMLElement,
  work: EmployeeWebEntryWork,
) {
  const scope = globalThis as typeof globalThis & {
    __DSH_BOOT_READY__?: PromiseWithResolvers<void>;
  };
  if (used || scope.__DSH_BOOT_READY__ !== undefined)
    throw new Error('The native document already has a startup owner');
  used = true;
  const readiness = Promise.withResolvers<void>();
  scope.__DSH_BOOT_READY__ = readiness;
  const lifetime = new AbortController();
  const entry = new AppWebEntry(container);
  let closing = false;
  let failed = false;
  let failure: unknown;
  let closePromise: Promise<EmployeeWebEntryClose> | undefined;

  // Keep exactly one run promise. The public run catches failure and resolves,
  // so onFailure, rather than promise resolution alone, determines readiness.
  const started: Promise<EmployeeWebEntryStart> = entry
    .run((reason) => {
      failed = true;
      failure = reason;
    })
    .then(
      (): EmployeeWebEntryStart =>
        closing
          ? { state: 'cancelled' }
          : failed
            ? { state: 'failed', reason: failure }
            : { state: 'ready' },
      (reason: unknown): EmployeeWebEntryStart => ({ state: 'failed', reason }),
    );
  const injecting = Promise.resolve()
    .then(() => {
      lifetime.signal.throwIfAborted();
      return work.applyRequiredInjections(lifetime.signal);
    })
    .then(
      () => {
        if (closing) readiness.reject(lifetime.signal.reason);
        else readiness.resolve();
      },
      (reason: unknown) => readiness.reject(reason),
    );

  return Object.freeze({
    started,
    close(): Promise<EmployeeWebEntryClose> {
      if (closePromise) return closePromise;
      closing = true;
      lifetime.abort();
      // The carrier owns this readiness gate, so cancellation must settle it
      // without allowing an owner baseline or a fake success through.
      readiness.reject(lifetime.signal.reason);
      closePromise = (async (): Promise<EmployeeWebEntryClose> => {
        await injecting;
        await started;
        const errors: unknown[] = [];
        try {
          await work.cleanup();
        } catch (reason) {
          errors.push(reason);
        }
        // dispose() does not join run(): it must be called only after the
        // continuation above has settled, including startup cancelled early.
        try {
          await entry.dispose();
        } catch (reason) {
          errors.push(reason);
        }
        return errors.length
          ? {
              state: 'unknown',
              reason: new AggregateError(
                errors,
                'Native document cleanup failed',
              ),
            }
          : { state: 'closed' };
      })().catch((reason: unknown): EmployeeWebEntryClose => ({
        state: 'unknown',
        reason,
      }));
      return closePromise;
    },
  });
}
