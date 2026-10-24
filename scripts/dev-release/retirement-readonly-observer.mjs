// One bounded mechanism for whole read-only rounds. Authority and classifiers
// stay with each caller. There is no apply/cleanup/write callback or error retry.
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
const need = (v, c) => {
  if (!v) throw Error(c);
};
export async function observeCompleteReadOnlyQuiescence({
  readObservation,
  classifyObservation,
  timeoutMs = 30_000,
  intervalMs = 250,
  now = () => performance.now(),
  sleep = (ms) => delay(ms),
}) {
  need(
    Number.isSafeInteger(timeoutMs) &&
      timeoutMs > 0 &&
      timeoutMs <= 60_000 &&
      Number.isSafeInteger(intervalMs) &&
      intervalMs > 0 &&
      intervalMs <= 1_000,
    'NATIVE_RETIREMENT_QUIESCENCE_LIMIT_INVALID',
  );
  const started = now(),
    deadline = started + timeoutMs;
  let attempts = 0;
  const activity = [];
  const check = () => {
    need(now() < deadline, 'NATIVE_RETIREMENT_QUIESCENCE_TIMEOUT');
  };
  const step = async (read) => {
    check();
    const signal = globalThis.AbortSignal.timeout(
      Math.max(1, Math.ceil(deadline - now())),
    );
    // Some pinned legacy physical reads have their own finite synchronous
    // deadline. Await their completion; never abandon them with Promise.race.
    const value = await read(signal);
    check();
    return value;
  };
  while (true) {
    check();
    attempts++;
    const observation = await readObservation(step);
    check();
    // Each caller owns its typed authority and full hard-fact classifier.
    // No exception is caught and reclassified as a transient lifecycle value.
    const {
      idle,
      classification,
      activity: observedActivity,
    } = classifyObservation(observation);
    need(
      typeof idle === 'boolean',
      'NATIVE_RETIREMENT_QUIESCENCE_CLASSIFIER_INVALID',
    );
    check();
    if (idle)
      return {
        ...classification,
        quiescenceObservation: {
          attempts,
          elapsedMs: Math.max(0, now() - started),
          completeReadOnlyAttempts: true,
          mutationRetried: false,
        },
      };
    if (activity.length < 32)
      activity.push({ attempt: attempts, ...observedActivity });
    try {
      check();
      await sleep(Math.min(intervalMs, deadline - now()));
      check();
    } catch (error) {
      // This diagnostic carries only validated counters, never upstream data.
      if (error.message === 'NATIVE_RETIREMENT_QUIESCENCE_TIMEOUT')
        error.quiescenceObservation = {
          attempts,
          activity,
          mutationRetried: false,
        };
      throw error;
    }
  }
}
