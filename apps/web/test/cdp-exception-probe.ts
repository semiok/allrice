import type { CDPSession } from '../../worker/node_modules/playwright-core/index.js';

/** Test-only observer for exceptions that application catches hide from pageerror. */
export function observeCdpExceptions(
  cdp: CDPSession,
  onException: (description: string) => void,
  onFailure: (cause: unknown) => void,
) {
  let closing = false;
  let current: { active: boolean } | undefined;
  let pending = Promise.resolve();
  const invalidate = () => {
    if (current) current.active = false;
    current = undefined;
  };
  cdp.on('Debugger.resumed', invalidate);
  // Reload can destroy a paused context without sending Debugger.resumed.
  cdp.on('Debugger.globalObjectCleared', invalidate);
  cdp.on('Debugger.paused', (event) => {
    const pause = { active: true };
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
          !pause.active &&
          String(cause).endsWith(
            'Protocol error (Debugger.resume): Can only perform operation while paused.',
          )
        )
          return;
        onFailure(cause);
      }
    });
  });
  return {
    stop() {
      closing = true;
      return pending;
    },
  };
}
