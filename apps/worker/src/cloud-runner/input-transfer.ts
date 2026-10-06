import type { Duplex } from 'node:stream';

export type CloudInputTransfer =
  'sent' | 'stopped' | 'canceled' | 'deadline' | 'unknown';

/** A Docker attach write can stall after the receiver exits. Its callback is
 * not an execution lease: keep checking authority, physical state and the
 * original deadline while sending. An uncertain write is never replayed. */
export function sendCloudInput(
  stream: Duplex,
  encoded: string,
  options: {
    deadline: number;
    signal: AbortSignal;
    maintainLease: () => Promise<boolean>;
    running: () => Promise<boolean>;
  },
): Promise<CloudInputTransfer> {
  return new Promise((resolve) => {
    let settled = false;
    let checking = false;
    const timers: {
      check?: ReturnType<typeof setInterval>;
      deadline?: ReturnType<typeof setTimeout>;
    } = {};
    const finish = (result: CloudInputTransfer) => {
      if (settled) return;
      settled = true;
      if (timers.check) clearInterval(timers.check);
      if (timers.deadline) clearTimeout(timers.deadline);
      stream.off('error', failed);
      stream.off('close', failed);
      options.signal.removeEventListener('abort', aborted);
      if (result !== 'sent') stream.destroy();
      resolve(result);
    };
    const failed = () => finish('unknown');
    const aborted = () => finish('canceled');
    const check = async () => {
      if (settled || checking) return;
      checking = true;
      let controlTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const state = await Promise.race([
          Promise.all([options.maintainLease(), options.running()]),
          new Promise<never>((_, reject) => {
            controlTimer = setTimeout(
              () => reject(Error('control timeout')),
              3000,
            );
          }),
        ]);
        if (settled) return;
        if (!state[0]) finish('canceled');
        else if (!state[1]) finish('stopped');
      } catch {
        finish('unknown');
      } finally {
        if (controlTimer) clearTimeout(controlTimer);
        checking = false;
      }
    };
    if (options.signal.aborted) return finish('canceled');
    if (!Number.isFinite(options.deadline) || options.deadline <= Date.now())
      return finish('deadline');
    options.signal.addEventListener('abort', aborted, { once: true });
    stream.once('error', failed);
    stream.once('close', failed);
    timers.deadline = setTimeout(
      () => finish('deadline'),
      options.deadline - Date.now(),
    );
    timers.check = setInterval(() => void check(), 200);
    void check();
    try {
      stream.write(encoded, (error) => {
        if (options.signal.aborted) finish('canceled');
        else if (Date.now() >= options.deadline) finish('deadline');
        else finish(error ? 'unknown' : 'sent');
      });
    } catch {
      finish('unknown');
    }
  });
}
