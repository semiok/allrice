import { describe, expect, it } from 'vitest';
import { settledTokenUsage } from '../../dsh/allrice-assistant-runtime.mjs';
describe('pinned native disjoint token usage', () => {
  it('charges all uncached, cache-read and cache-write input', () => {
    expect(
      settledTokenUsage({
        inputTokens: 10,
        cacheReadTokens: 900,
        cacheWriteTokens: 90,
        outputTokens: 5,
      }),
    ).toEqual({ inputTokens: 1000, outputTokens: 5 });
  });
  it.each([
    undefined,
    null,
    '100',
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER,
  ])('keeps unknown or invalid cache dimensions reserved (%s)', (value) => {
    const usage =
      value === undefined
        ? { outputTokens: 5 }
        : { inputTokens: 10, cacheReadTokens: value, outputTokens: 5 };
    expect(settledTokenUsage(usage)).toEqual({ outputTokens: 5 });
  });
  it('optional absent cache fields mean zero and invalid output remains reserved', () => {
    expect(settledTokenUsage({ inputTokens: 10, outputTokens: -1 })).toEqual({
      inputTokens: 10,
    });
  });
});
