import { describe, expect, it } from 'vitest';
import { projectNativeUsage } from './native-usage.js';

describe('pinned native subscription receipts', () => {
  const usage = {
    inputTokens: 10,
    cacheReadTokens: 3,
    cacheWriteTokens: 2,
    outputTokens: 7,
  };
  it('counts disjoint input once, preserving observed cache details', () => {
    expect(projectNativeUsage(usage, true, true)).toEqual({
      inputTokens: 15,
      cachedInputTokens: 3,
      outputTokens: 7,
      usageComplete: true,
      cacheUsageKnown: true,
    });
    expect(projectNativeUsage(usage, true, false).inputTokens).toBe(10);
  });
  it.each([
    undefined,
    null,
    {},
    { ...usage, inputTokens: -1 },
    { ...usage, inputTokens: 1.5 },
    { ...usage, cacheReadTokens: '3' },
    { ...usage, inputTokens: Number.MAX_SAFE_INTEGER },
    { ...usage, outputTokens: 0 },
    { ...usage, outputTokens: NaN },
    { inputTokens: 0, outputTokens: 0 },
  ])('keeps absent or invalid input/output unknown: %j', (value) => {
    expect(projectNativeUsage(value, true, true).usageComplete).toBe(false);
  });
  it('does not conflate missing cache detail with missing total tokens', () => {
    expect(
      projectNativeUsage({ inputTokens: 10, outputTokens: 7 }, true, true),
    ).toMatchObject({ usageComplete: true, cacheUsageKnown: false });
  });
});
