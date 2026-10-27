import type { P27CodexWorkerFixtureCleanup } from './p27-codex-worker-fixture.ts';

export function workerFixtureCleanupConfirmed(
  proof?: P27CodexWorkerFixtureCleanup,
) {
  return (
    proof?.globalDatabaseClosed === true &&
    proof.databaseEnvironmentRestored === true &&
    // null is missing initialization proof, not evidence that no schema/pool
    // was created. A failed fixture attempt must remain explicitly unconfirmed.
    proof.fixture?.schemaRemoved === true &&
    proof.fixture.storageRemoved === true &&
    proof.fixture.databaseClosed === true &&
    proof.fixture.adminClosed === true
  );
}

export async function runP27WorkerSequence<T>(input: {
  assistant: () => Promise<T>;
  ordinary: (verifiedAssistant: T) => Promise<void>;
}) {
  // The first callback includes all durable result/receipt/job/quota checks.
  // Rejection prevents even preparing a second paid task; never auto-retry.
  const first = await input.assistant();
  await input.ordinary(first);
}

/** Only script-local lease maintenance, not another job/agent runner. */
export function maintainP27Lease(input: {
  heartbeat: () => Promise<{ active: boolean }>;
  abort: AbortController;
  intervalMs?: number;
}) {
  let pending: Promise<void> | undefined;
  let stopped = false;
  let healthy = true;
  const timer = setInterval(() => {
    if (pending || stopped) return;
    pending = input
      .heartbeat()
      .then(
        (state) => {
          if (!state.active) {
            healthy = false;
            input.abort.abort();
          }
        },
        () => {
          healthy = false;
          input.abort.abort();
        },
      )
      .finally(() => {
        pending = undefined;
      });
  }, input.intervalMs ?? 5000);
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await pending;
      return { healthy };
    },
  };
}

export async function boundedP27Wait<T>(
  promise: Promise<T>,
  milliseconds: number,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Error('p27_worker_deadline')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
