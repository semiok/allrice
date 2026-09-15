import { record } from './event-projector.js';

/** Pinned DSH reports uncached, read-cache and write-cache input separately.
 * Missing/synthetic usage is not evidence of a zero-token successful call. */
export function projectNativeUsage(
  value: unknown,
  observedOutput: boolean,
  subscription: boolean,
) {
  const raw = record(value);
  const valid = (v: unknown): v is number =>
    typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  const input = raw?.inputTokens;
  const output = raw?.outputTokens;
  const read = raw?.cacheReadTokens;
  const write = raw?.cacheWriteTokens;
  const allInput =
    valid(input) &&
    (read === undefined || valid(read)) &&
    (write === undefined || valid(write))
      ? input + (read ?? 0) + (write ?? 0)
      : undefined;
  const complete =
    valid(allInput) &&
    allInput > 0 &&
    valid(output) &&
    (!observedOutput || output > 0);
  return {
    inputTokens: subscription
      ? valid(allInput)
        ? allInput
        : 0
      : valid(input)
        ? input
        : 0,
    cachedInputTokens: valid(read) ? read : 0,
    outputTokens: valid(output) ? output : 0,
    usageComplete: complete,
    cacheUsageKnown: complete && valid(read) && valid(write),
  };
}
