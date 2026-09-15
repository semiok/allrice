import { parseArguments, requireCheck } from './p27-assistant-preflight.ts';
import type { P27WorkerFixtureCleanup } from './p27-worker-fixture.ts';

export function workerFixtureCleanupConfirmed(proof?: P27WorkerFixtureCleanup) {
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

/** Separate authorization from the one-adapter-call P27 experiment. These two
 * Worker executions may each make multiple provider calls within frozen limits. */
export function parseP27WorkerArguments(args: string[]) {
  const parsed = parseArguments(args);
  requireCheck(
    args.includes('--provider=gemini') && parsed.providerRoute === 'gemini',
    'worker_explicit_gemini_required',
  );
  return parsed;
}

export function authorizeP27Worker(env: NodeJS.ProcessEnv, sha: string) {
  requireCheck(
    /^[a-f0-9]{40}$/.test(sha) &&
      env.ALLRICE_B6_P27_WORKER_AUTHORIZED === '1' &&
      env.ALLRICE_B6_P27_WORKER_AUTHORIZED_SHA === sha &&
      env.ALLRICE_B6_P27_WORKER_AUTHORIZED_PROVIDER === 'gemini' &&
      env.ALLRICE_B6_P27_WORKER_MAX_EXECUTIONS === '2' &&
      env.ALLRICE_B6_P27_WORKER_ORDINARY_ESTIMATE_ACK === '1',
    'worker_two_execution_authorization_required',
  );
  requireCheck(
    !env.DATABASE_URL && !env.ALLRICE_TEST_DATABASE_URL,
    'worker_ambient_database_denied',
  );
}

/** Ordinary Worker still uses its existing estimator, not assistant receipts.
 * Explicit prices avoid the legacy missing-price=0 path. Cache discount and
 * provider-internal retry accounting are NOT a conservative invoice bound. */
export const P27_ORDINARY_PRICING = Object.freeze({
  'gemini:gemini-3.8-flash': {
    inputCentsPerMillion: 75,
    outputCentsPerMillion: 375,
  },
});

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
