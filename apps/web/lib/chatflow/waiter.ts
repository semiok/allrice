export interface ChatFlowWaiter {
  signal(): void;
  wait(
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<'signal' | 'timeout' | 'aborted'>;
}

export function createChatFlowWaiter(): ChatFlowWaiter {
  let waiting: (() => void) | null = null;
  let pending = false;
  return {
    signal() {
      pending = true;
      waiting?.();
    },
    async wait(timeoutMs, signal) {
      if (pending) {
        pending = false;
        return 'signal';
      }
      return new Promise((resolve) => {
        let settled = false;
        const finish = (result: 'signal' | 'timeout' | 'aborted') => {
          if (settled) return;
          settled = true;
          waiting = null;
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          if (result === 'signal') pending = false;
          resolve(result);
        };
        const abort = () => finish('aborted');
        const timer = setTimeout(() => finish('timeout'), timeoutMs);
        waiting = () => finish('signal');
        signal.addEventListener('abort', abort, { once: true });
      });
    },
  };
}
