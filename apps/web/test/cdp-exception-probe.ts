import type { CDPSession } from '../../worker/node_modules/playwright-core/index.js';

/** Test-only observer; the caller enables both Runtime and Debugger domains. */
export function observeCdpExceptions(
  cdp: CDPSession,
  onException: (description: string) => void,
  onFailure: (cause: unknown) => void,
) {
  let closing = false;
  let current: { active: boolean; release: () => void } | undefined;
  let pending = Promise.resolve();
  const invalidate = () => {
    if (current) {
      current.active = false;
      current.release();
    }
    current = undefined;
  };
  cdp.on('Debugger.resumed', invalidate);
  // Reload can destroy a paused context without sending Debugger.resumed.
  cdp.on('Runtime.executionContextsCleared', invalidate);
  cdp.on('Debugger.paused', (event) => {
    let release!: () => void;
    const invalidated = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pause = { active: true, release };
    current = pause;
    onException(event.data?.description ?? '');
    pending = pending.then(async () => {
      if (closing || !pause.active) return;
      try {
        await cdp.send('Debugger.resume');
      } catch (cause) {
        if (closing) return;
        // Navigation may invalidate the pause while the command is in flight.
        // Require the protocol event as well as this exact error; other probe
        // failures, and every exception already observed, remain test failures.
        if (
          String(cause).endsWith(
            'Protocol error (Debugger.resume): Can only perform operation while paused.',
          )
        ) {
          // The invalidation event can arrive after the command rejection.
          // drain() must observe it before the test may assert success.
          await invalidated;
          return;
        }
        onFailure(cause);
      }
    });
  });
  return {
    async drain() {
      let observed: Promise<void>;
      do {
        observed = pending;
        await observed;
      } while (pending !== observed);
    },
    stop() {
      closing = true;
      invalidate();
      return pending;
    },
  };
}
